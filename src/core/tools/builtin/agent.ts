import { platform } from 'node:os';

import { z } from 'zod';

import type { ChatProvider, Message } from '#/provider/types';

import { errorMessage } from '../../errors';
import type { AgentEvent, EventDispatcher } from '../../events';
import { runTurn } from '../../loop/run-turn';
import { ApprovalManager } from '../../permission/approval';
import type { PermissionContext, PermissionRuntime } from '../../permission/pipeline';
import type { SubagentDefinition } from '../../subagents';
import type { TaskManager } from '../../tasks';
import { defineTool, type Tool, type ToolResult } from '../tool';

import { createBashTool } from './bash';
import { editTool } from './edit';
import { truncate } from './fs-utils';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { webFetchTool } from './web-fetch';
import { webSearchTool } from './web-search';
import { writeTool } from './write';

const SUBAGENT_MAX_STEPS = 30;
const MAX_OUTPUT_CHARS = 30_000;

const inputSchema = z.object({
  description: z.string().describe('一句话描述这个子任务'),
  prompt: z.string().describe('交给子代理的完整任务描述（它看不到主会话历史，必须自包含）'),
  subagent_type: z.string().describe('子代理类型；可用清单见工具描述'),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'true 时后台运行：立即返回 taskId，用 task_output 查看进度与最终结果（block=true 可挂起等待），task_stop 中断；结束时收到通知',
    ),
});

/** 子代理默认只读工具集：天然规避子代理内无法弹审批的问题 */
const DEFAULT_SUBAGENT_TOOLS: Tool[] = [readTool, globTool, grepTool];

/** 自定义子代理工具池里的只读成员（其余成员使子代理被视为"可写"，prompt 相应调整） */
const READONLY_TOOL_NAMES = new Set(['read', 'glob', 'grep', 'web_fetch', 'web_search']);

const ROLE_PROMPTS: Record<string, string> = {
  explore:
    '你是代码探索子代理。用只读工具（read / glob / grep）在代码库中定位与任务相关的实现，' +
    '输出结论：涉及的文件与行号、关键逻辑摘要、与任务相关的发现。',
  plan:
    '你是实现规划子代理。用只读工具（read / glob / grep）了解代码现状，' +
    '输出一份可执行的实现计划：分步动作、涉及的文件、风险与验证方式。',
};

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  explore: '代码探索：定位实现、输出涉及的文件与行号、关键逻辑摘要（只读）',
  plan: '实现规划：分析代码现状，产出分步实现计划（只读）',
};

/** 创建 agent 工具所需的宿主能力，registry 创建时闭包注入 */
export interface AgentToolHost {
  provider: ChatProvider;
  /** 每次调用取当前模型，/model 运行时切换对后续子代理生效 */
  getModel: () => string;
  /** 提供后支持 run_in_background（后台任务经它登记、输出与通知）；缺省时该参数报错回喂 */
  tasks?: TaskManager;
  /** 自定义子代理定义（.misty/agents/*.md）；与内置 explore/plan 同名时被内置遮蔽 */
  subagents?: SubagentDefinition[];
  /**
   * 取主会话权限上下文（模式/规则/会话级审批累积），每次调用现读使 /mode 切换立即生效；
   * 缺省按 bypassPermissions 判定。子代理无交互能力：判定为 ask 的调用由子代理私有的
   * ApprovalManager 立即拒绝并回喂说明，不进主会话审批流
   */
  getPermissionContext?: () => PermissionContext;
}

interface SubagentEntry {
  name: string;
  description: string;
}

/** 内置在前：同名自定义定义被内置遮蔽，不出现在清单里 */
function availableEntries(host: AgentToolHost): SubagentEntry[] {
  const builtins = Object.entries(ROLE_PROMPTS).map(([name]) => ({
    name,
    description: BUILTIN_DESCRIPTIONS[name]!,
  }));
  const customs = (host.subagents ?? [])
    .filter((def) => ROLE_PROMPTS[def.name] === undefined)
    .map((def) => ({ name: def.name, description: def.description }));
  return [...builtins, ...customs];
}

function buildDescription(host: AgentToolHost): string {
  const lines = availableEntries(host).map((entry) => `- ${entry.name}：${entry.description}`);
  return (
    '启动一个子代理处理独立子任务（独立上下文与消息历史）。\n' +
    '可用子代理类型（subagent_type）：\n' +
    `${lines.join('\n')}\n` +
    '子代理看不到本会话历史，prompt 必须自包含；前台调用返回其最终结论文本，' +
    'run_in_background=true 时立即返回 taskId 后台运行（用 task_output 取结果）。'
  );
}

/** 自定义子代理的工具池：无状态内置工具 + bash（共享宿主 TaskManager 时） */
function buildToolPool(tasks: TaskManager | undefined): Map<string, Tool> {
  const pool = new Map<string, Tool>();
  for (const tool of [readTool, writeTool, editTool, globTool, grepTool, webFetchTool, webSearchTool]) {
    pool.set(tool.name, tool);
  }
  if (tasks !== undefined) {
    pool.set('bash', createBashTool(tasks));
  }
  return pool;
}

interface SubagentSpec {
  systemPrompt: string;
  tools: Tool[];
  model: string;
}

function environmentLines(cwd: string, writable: boolean): string[] {
  const environment =
    platform() === 'win32' ? '运行环境为 Windows。' : `运行环境：${platform()}。`;
  return [
    writable
      ? '你没有交互审批能力：需要审批的操作会被自动拒绝，届时改用只读方式获取信息，' +
        '或在最终结论中说明需要主代理代为执行的写/执行操作。'
      : '不要修改任何文件；你没有交互能力，直接给出最终结论文本。',
    '',
    `当前工作目录：${cwd}（工具调用中的相对路径都相对它解析）。`,
    environment,
  ];
}

function resolveSpec(
  host: AgentToolHost,
  type: string,
  cwd: string,
): { ok: true; spec: SubagentSpec } | { ok: false; error: string } {
  const rolePrompt = ROLE_PROMPTS[type];
  if (rolePrompt !== undefined) {
    return {
      ok: true,
      spec: {
        systemPrompt: [rolePrompt, ...environmentLines(cwd, false)].join('\n'),
        tools: DEFAULT_SUBAGENT_TOOLS,
        model: host.getModel(),
      },
    };
  }
  const def = host.subagents?.find((candidate) => candidate.name === type);
  if (def === undefined) {
    const available = availableEntries(host)
      .map((entry) => `${entry.name}（${entry.description}）`)
      .join('、');
    return { ok: false, error: `未知子代理类型：${type}。可用类型：${available}` };
  }
  const pool = buildToolPool(host.tasks);
  const requested = def.tools ?? ['read', 'glob', 'grep'];
  const tools: Tool[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const tool = pool.get(name);
    if (tool === undefined) {
      unknown.push(name);
    } else if (!tools.some((existing) => existing.name === name)) {
      tools.push(tool);
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `子代理 ${type} 声明了未知工具：${unknown.join(', ')}。` +
        `可用工具：${[...pool.keys()].join(', ')}`,
    };
  }
  const writable = requested.some((name) => !READONLY_TOOL_NAMES.has(name));
  return {
    ok: true,
    spec: {
      systemPrompt: [def.prompt, ...environmentLines(cwd, writable)].join('\n'),
      tools,
      model: def.model ?? host.getModel(),
    },
  };
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.content !== '') {
      return message.content;
    }
  }
  return '';
}

interface SubagentRunDeps {
  host: AgentToolHost;
  spec: SubagentSpec;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  dispatchEvent: EventDispatcher;
  permission: PermissionRuntime;
}

async function runSubagent(deps: SubagentRunDeps): Promise<ToolResult> {
  const messages: Message[] = [{ role: 'user', content: deps.prompt }];
  const result = await runTurn({
    provider: deps.host.provider,
    model: deps.spec.model,
    systemPrompt: deps.spec.systemPrompt,
    messages,
    tools: deps.spec.tools,
    cwd: deps.cwd,
    maxSteps: SUBAGENT_MAX_STEPS,
    signal: deps.signal,
    dispatchEvent: deps.dispatchEvent,
    permission: deps.permission,
  });
  const text = lastAssistantText(messages);
  if (text === '') {
    return {
      output: `子代理没有产出文本结论（stopReason: ${result.stopReason}）`,
      isError: true,
    };
  }
  const output = truncate(
    text,
    MAX_OUTPUT_CHARS,
    `[输出过长已截断，仅保留前 ${MAX_OUTPUT_CHARS} 字符]`,
  );
  if (result.stopReason === 'interrupted') {
    return { output: `${output}\n[子代理已被中断，以上为部分结果]`, isError: true };
  }
  return { output };
}

/**
 * 子代理工具（借鉴 Claude Code AgentTool 与 kimi-code 的无状态 loop 复用）：
 * 起一个独立的 runTurn——新消息数组、专用 system prompt（含 cwd，不含 AGENTS.md）、
 * 默认只读工具集。子代理内部事件不进主事件流（UI 只看到 agent 工具本身的开始/结束）；
 * 前台调用父 signal abort 级联到子 loop，返回最后一条 assistant 文本；
 * run_in_background=true 时登记到 TaskManager 立即返回 taskId，缓冲累积流式文本与
 * 工具调用摘要，结束/中断经 task-finished 事件通道通知。
 */
export function createAgentTool(host: AgentToolHost): Tool {
  return defineTool({
    name: 'agent',
    description: buildDescription(host),
    inputSchema,
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) =>
      input.run_in_background === true
        ? `Agent(后台 ${input.subagent_type}) ${input.description}`
        : `Agent(${input.subagent_type}) ${input.description}`,
    call: async (input, ctx) => {
      const resolved = resolveSpec(host, input.subagent_type, ctx.cwd);
      if (!resolved.ok) {
        return { output: resolved.error, isError: true };
      }
      const { spec } = resolved;

      // 子代理无交互能力：审批请求自动拒绝并回喂说明（对齐 print 无头模式的处理方式）。
      // 私有 ApprovalManager：ask 不出子代理，主会话的挂起审批列表不受污染
      const approvals = new ApprovalManager(ctx.cwd);
      const permission: PermissionRuntime = {
        getContext: () =>
          host.getPermissionContext?.() ?? {
            mode: 'bypassPermissions',
            rules: [],
            sessionApprovals: [],
            cwd: ctx.cwd,
          },
        approvals,
      };
      const makeDispatcher = (sink?: (event: AgentEvent) => void): EventDispatcher => {
        return (event) => {
          if (event.type === 'approval-requested') {
            approvals.reply(event.request.id, {
              decision: 'reject',
              feedback:
                '子代理没有交互审批能力，该操作已自动拒绝。请改用只读方式完成，' +
                '或在最终结论中说明需要主代理代为执行的写/执行操作。',
            });
            return;
          }
          sink?.(event);
        };
      };
      const runDeps = { host, spec, prompt: input.prompt, cwd: ctx.cwd, permission };

      if (input.run_in_background !== true) {
        // 中断级联：父 signal abort → 子 loop abort
        const controller = new AbortController();
        if (ctx.signal.aborted) {
          controller.abort();
        } else {
          ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        return runSubagent({
          ...runDeps,
          signal: controller.signal,
          dispatchEvent: makeDispatcher(),
        });
      }

      if (host.tasks === undefined) {
        return { output: '当前环境不支持后台子代理（缺少任务管理器）', isError: true };
      }
      const handle = host.tasks.startAgent(`Agent(${input.subagent_type}) ${input.description}`);
      const toolsByName = new Map(spec.tools.map((tool) => [tool.name, tool]));
      // 缓冲累积：assistant 流式文本 + 工具调用摘要行 + 错误；最终结论在落定前写入尾部
      const sink = (event: AgentEvent): void => {
        switch (event.type) {
          case 'text-delta':
            handle.appendOutput(event.text);
            break;
          case 'tool-call-started': {
            const summary = toolsByName.get(event.name)?.describeCall(event.input) ?? event.name;
            handle.appendOutput(`\n⏵ ${summary}\n`);
            break;
          }
          case 'error':
            handle.appendOutput(`\n✗ ${event.message}\n`);
            break;
          default:
            break;
        }
      };
      // 后台任务刻意不级联 ctx.signal：interrupt / turn 结束不影响它（与 bash 后台一致）
      void runSubagent({ ...runDeps, signal: handle.signal, dispatchEvent: makeDispatcher(sink) })
        .then((result) => {
          handle.appendOutput(`\n--- 最终结论 ---\n${result.output}\n`);
          handle.settle(result.isError === true ? 1 : 0);
        })
        .catch((error: unknown) => {
          handle.appendOutput(`\n[子代理异常] ${errorMessage(error)}`);
          handle.settle(1);
        });
      return {
        output:
          `后台子代理 ${handle.task.id} 已启动（${input.subagent_type}：${input.description}）。\n` +
          '用 task_output 查看进度与最终结果（block=true 可挂起等待结束）；任务结束时会收到通知。',
      };
    },
  });
}
