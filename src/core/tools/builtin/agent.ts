import { platform } from 'node:os';

import { z } from 'zod';

import type { ChatProvider, Message } from '#/provider/types';

import { harvestBoardEntries, type TaskBoard } from '../../board';
import { errorMessage } from '../../errors';
import type { AgentEvent, EventDispatcher } from '../../events';
import { runTurn } from '../../loop/run-turn';
import { ApprovalManager } from '../../permission/approval';
import type { PermissionContext, PermissionRuntime } from '../../permission/pipeline';
import type { SubagentDefinition } from '../../subagents';
import type { TaskManager } from '../../tasks';
import { defineTool, type Tool, type ToolContext, type ToolResult } from '../tool';

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

const taskItemSchema = z.object({
  description: z.string().describe('One-line description of this subtask'),
  prompt: z
    .string()
    .describe(
      'The complete task description handed to the subagent (it cannot see the main session history, so it must be self-contained)',
    ),
  subagent_type: z.string().describe('Subagent type; the available list is in the tool description'),
});

/** 批量并行的单个任务；字段与单发模式三字段同形 */
type BatchTaskInput = z.output<typeof taskItemSchema>;

const inputSchema = z.object({
  description: z
    .string()
    .optional()
    .describe('One-line description of this subtask (required in single-task mode)'),
  prompt: z
    .string()
    .optional()
    .describe(
      'The complete task description handed to the subagent (it cannot see the main session history, so it must be self-contained; required in single-task mode)',
    ),
  subagent_type: z
    .string()
    .optional()
    .describe('Subagent type; the available list is in the tool description (required in single-task mode)'),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'When true, run in the background: returns a taskId immediately; inspect progress and the final result with task_output (block=true waits), interrupt with task_stop; you are notified when it finishes',
    ),
  tasks: z
    .array(taskItemSchema)
    .min(1)
    .max(8)
    .optional()
    .describe(
      'Parallel batch mode: start 1-8 mutually independent subagents at once and get results aggregated section by section; when given, the single-task fields are ignored',
    ),
});

/** 子代理默认只读工具集：天然规避子代理内无法弹审批的问题 */
const DEFAULT_SUBAGENT_TOOLS: Tool[] = [readTool, globTool, grepTool];

/** 自定义子代理工具池里的只读成员（其余成员使子代理被视为"可写"，prompt 相应调整） */
const READONLY_TOOL_NAMES = new Set(['read', 'glob', 'grep', 'web_fetch', 'web_search']);

const ROLE_PROMPTS: Record<string, string> = {
  explore:
    'You are a code exploration subagent. Use the read-only tools (read / glob / grep) to locate the implementation relevant to the task in the codebase. ' +
    'Your conclusion must be self-contained and specific: open with an overall finding, then list the files and line numbers involved (path:line) with a one-line summary of each, ' +
    'and the discoveries directly relevant to the task. Cite real symbol names and paths — never write vague phrases like "somewhere around".',
  plan:
    'You are an implementation planning subagent. Use the read-only tools (read / glob / grep) to understand the current state of the code, then produce an implementation plan that can be executed directly: ' +
    'step-by-step actions (which file each step changes and what it does), the order and dependencies between steps, the risks, and how to verify (which commands to run). ' +
    'Base the plan on real code: cite concrete files and symbols, never assumptions.',
};

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  explore:
    'Code exploration: locate implementations, report the files and line numbers involved, summarize key logic (read-only)',
  plan: 'Implementation planning: analyze the current code and produce a step-by-step implementation plan (read-only)',
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
   * 任务级共享证据板：提供后子代理 systemPrompt 追加协作纪律段（含板内容快照），
   * 结论中的 VERIFIED_FACT / DEADEND 标记行被收割进板，供后续子代理复用
   */
  board?: TaskBoard;
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
  const lines = availableEntries(host).map((entry) => `- ${entry.name}: ${entry.description}`);
  return (
    'Start a subagent for an independent subtask: it works in its own context and message history, so the exploration does not consume this session\'s context, and it brings back only its final conclusion. ' +
    'Suited to wide code exploration / searching and to mutually independent parallel subtasks.\n' +
    'Available subagent types (subagent_type):\n' +
    `${lines.join('\n')}\n` +
    'A subagent cannot see this session history, so the prompt must be self-contained: state the goal, the scope (directories / modules involved), known leads, and the output format you expect.\n' +
    'A foreground call blocks until it returns its final conclusion text; with run_in_background=true it returns a taskId immediately and runs in the background (collect the result with task_output).\n' +
    'Parallel batch: pass 1-8 { description, prompt, subagent_type } items in tasks for mutually independent, parallelizable subtasks; ' +
    'they run concurrently and the results are aggregated section by section, with one failure not affecting the others. Do not put subtasks that depend on each other in the same batch.'
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
    platform() === 'win32' ? 'Environment: Windows.' : `Environment: ${platform()}.`;
  return [
    writable
      ? 'You have no interactive approval capability: an operation that needs approval is automatically rejected. When that happens, gather the information read-only instead, ' +
        'or state in your final conclusion which write or execute operations the main agent should perform on your behalf.'
      : 'Do not modify any file; you have no interactive capability. Your final conclusion text is handed back to the main agent verbatim, so it must be self-contained and specific (with file paths and line numbers).',
    '',
    `Current working directory: ${cwd} (relative paths in tool calls resolve against it).`,
    environment,
  ];
}

/**
 * 共享证据板协作纪律段：call 时现读保证内容新鲜；板非空时附当前板内容快照
 */
function boardPromptSection(host: AgentToolHost): string | null {
  const board = host.board;
  if (board === undefined) {
    return null;
  }
  const lines = [
    'This task has a shared evidence board (shared with fellow subagents); read the board below before you start.',
    'Output each key fact you confirm on its own line as "VERIFIED_FACT: <one-line objective conclusion>", ' +
      'and each direction you rule out on its own line as "DEADEND: <one-line conclusion>".',
    'Only write objective content you have verified in real tool output, and do not restate entries already on the board.',
  ];
  if (!board.isEmpty()) {
    lines.push('', board.render());
  }
  return lines.join('\n');
}

function withBoardSection(host: AgentToolHost, systemPrompt: string): string {
  const section = boardPromptSection(host);
  return section === null ? systemPrompt : `${systemPrompt}\n\n${section}`;
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
        systemPrompt: withBoardSection(host, [rolePrompt, ...environmentLines(cwd, false)].join('\n')),
        tools: DEFAULT_SUBAGENT_TOOLS,
        model: host.getModel(),
      },
    };
  }
  const def = host.subagents?.find((candidate) => candidate.name === type);
  if (def === undefined) {
    const available = availableEntries(host)
      .map((entry) => `${entry.name} (${entry.description})`)
      .join(', ');
    return { ok: false, error: `Unknown subagent type: ${type}. Available types: ${available}` };
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
        `Subagent ${type} declares unknown tools: ${unknown.join(', ')}. ` +
        `Available tools: ${[...pool.keys()].join(', ')}`,
    };
  }
  const writable = requested.some((name) => !READONLY_TOOL_NAMES.has(name));
  return {
    ok: true,
    spec: {
      systemPrompt: withBoardSection(host, [def.prompt, ...environmentLines(cwd, writable)].join('\n')),
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
  /** 子代理类型名（证据板条目的来源标注用） */
  type: string;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  dispatchEvent: EventDispatcher;
  permission: PermissionRuntime;
}

/** 收尾救援只给两步：第一步总结，兜底一步防意外；tools 为空使其只能输出文本 */
const SALVAGE_MAX_STEPS = 2;

/** 对标 Cairn execute→conclude：探索烂尾时强令只总结已验证结论 */
const SALVAGE_MESSAGE =
  'You have been told to stop exploring immediately: summarize only the conclusions and findings already confirmed in real tool output, ' +
  'mark anything unverified explicitly as "unverified", and do not call any tool or continue exploring.';

function harvestToBoard(host: AgentToolHost, type: string, text: string): void {
  if (host.board === undefined) {
    return;
  }
  for (const entry of harvestBoardEntries(text)) {
    host.board.add(entry.kind, entry.text, `Agent(${type})`);
  }
}

async function runSubagent(deps: SubagentRunDeps): Promise<ToolResult> {
  const messages: Message[] = [{ role: 'user', content: deps.prompt }];
  const baseTurn = {
    provider: deps.host.provider,
    model: deps.spec.model,
    systemPrompt: deps.spec.systemPrompt,
    messages,
    cwd: deps.cwd,
    signal: deps.signal,
    dispatchEvent: deps.dispatchEvent,
    permission: deps.permission,
  };
  const result = await runTurn({
    ...baseTurn,
    tools: deps.spec.tools,
    maxSteps: SUBAGENT_MAX_STEPS,
  });
  let text = lastAssistantText(messages);
  // 救援条件：有真实探索历史（messages 不止初始 prompt）却烂尾；用户主动中断不救
  let salvageNote: string | null = null;
  if (text === '' && result.stopReason !== 'interrupted' && messages.length > 1) {
    messages.push({ role: 'user', content: SALVAGE_MESSAGE });
    await runTurn({ ...baseTurn, tools: [], maxSteps: SALVAGE_MAX_STEPS });
    text = lastAssistantText(messages);
    if (text !== '' && (result.stopReason === 'max-steps' || result.stopReason === 'error')) {
      salvageNote = 'The subagent did not wrap up normally; the following is its salvage summary';
    }
  }
  if (text === '') {
    return {
      output: `The subagent produced no text conclusion (stopReason: ${result.stopReason})`,
      isError: true,
    };
  }
  harvestToBoard(deps.host, deps.type, text);
  const body = salvageNote === null ? text : `${salvageNote}\n${text}`;
  const output = truncate(
    body,
    MAX_OUTPUT_CHARS,
    `[Output truncated: only the first ${MAX_OUTPUT_CHARS} characters are kept]`,
  );
  if (result.stopReason === 'interrupted') {
    return { output: `${output}\n[The subagent was interrupted; the above is a partial result]`, isError: true };
  }
  return { output };
}

interface SubagentScope {
  permission: PermissionRuntime;
  makeDispatcher: (sink?: (event: AgentEvent) => void) => EventDispatcher;
}

/**
 * 单个子代理运行的私有作用域（独立权限运行时 + 事件分发器）。
 * 子代理无交互能力：审批请求自动拒绝并回喂说明（对齐 print 无头模式的处理方式）。
 * 私有 ApprovalManager：ask 不出子代理，主会话的挂起审批列表不受污染
 */
function createSubagentScope(host: AgentToolHost, cwd: string): SubagentScope {
  const approvals = new ApprovalManager(cwd);
  const permission: PermissionRuntime = {
    getContext: () =>
      host.getPermissionContext?.() ?? {
        mode: 'bypassPermissions',
        rules: [],
        sessionApprovals: [],
        cwd,
      },
    approvals,
  };
  const makeDispatcher = (sink?: (event: AgentEvent) => void): EventDispatcher => {
    return (event) => {
      if (event.type === 'approval-requested') {
        approvals.reply(event.request.id, {
          decision: 'reject',
          feedback:
            'A subagent has no interactive approval capability, so this operation was automatically rejected. Complete it read-only instead, ' +
            'or state in your final conclusion which write or execute operations the main agent should perform on your behalf.',
        });
        return;
      }
      sink?.(event);
    };
  };
  return { permission, makeDispatcher };
}

/** 中断级联：父 signal abort → 子 loop abort */
function cascadeSignal(parent: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

interface BatchSection {
  index: number;
  type: string;
  description: string;
  output: string;
  isError: boolean;
}

function formatBatchSections(sections: BatchSection[]): string {
  return sections
    .map(
      (section) =>
        `## [${section.index}] ${section.type} · ${section.description}` +
        `${section.isError ? ' ✗' : ''}\n${section.output}`,
    )
    .join('\n\n');
}

/**
 * 批量内单个子任务：复用 resolveSpec + runSubagent 路径，独立权限作用域与消息历史；
 * 未知类型等解析失败直接产出错误节，不启动子代理、不影响其他任务
 */
async function runBatchTask(
  host: AgentToolHost,
  task: BatchTaskInput,
  index: number,
  cwd: string,
  signal: AbortSignal,
): Promise<BatchSection> {
  const resolved = resolveSpec(host, task.subagent_type, cwd);
  if (!resolved.ok) {
    return {
      index,
      type: task.subagent_type,
      description: task.description,
      output: resolved.error,
      isError: true,
    };
  }
  const scope = createSubagentScope(host, cwd);
  const result = await runSubagent({
    host,
    spec: resolved.spec,
    type: task.subagent_type,
    prompt: task.prompt,
    cwd,
    signal,
    dispatchEvent: scope.makeDispatcher(),
    permission: scope.permission,
  });
  return {
    index,
    type: task.subagent_type,
    description: task.description,
    output: result.output,
    isError: result.isError === true,
  };
}

function runBatchAll(
  host: AgentToolHost,
  tasks: BatchTaskInput[],
  cwd: string,
  signal: AbortSignal,
): Promise<BatchSection[]> {
  return Promise.all(
    tasks.map((task, offset) => runBatchTask(host, task, offset + 1, cwd, signal)),
  );
}

/**
 * 批量模式：前台并发后分节聚合（全部失败才整体 isError）；
 * 后台登记单个任务，内部并发跑完把分节聚合文本写入缓冲后 settle（与单发后台同通道）
 */
async function callBatch(
  host: AgentToolHost,
  tasks: BatchTaskInput[],
  background: boolean,
  ctx: ToolContext,
): Promise<ToolResult> {
  const first = tasks[0]!;
  if (!background) {
    const sections = await runBatchAll(host, tasks, ctx.cwd, cascadeSignal(ctx.signal));
    const output = formatBatchSections(sections);
    if (sections.every((section) => section.isError)) {
      return { output, isError: true };
    }
    return { output };
  }

  if (host.tasks === undefined) {
    return {
      output: 'Background subagents are not supported in this environment (no task manager)',
      isError: true,
    };
  }
  const handle = host.tasks.startAgent(
    `Agent(parallel ${tasks.length} tasks) ${first.description} et al.`,
  );
  // 后台任务刻意不级联 ctx.signal：interrupt / turn 结束不影响它（与单发后台一致）
  void runBatchAll(host, tasks, ctx.cwd, handle.signal)
    .then((sections) => {
      const allFailed = sections.every((section) => section.isError);
      handle.appendOutput(`\n--- Final conclusions ---\n${formatBatchSections(sections)}\n`);
      handle.settle(allFailed ? 1 : 0);
    })
    .catch((error: unknown) => {
      handle.appendOutput(`\n[Subagent error] ${errorMessage(error)}`);
      handle.settle(1);
    });
  return {
    output:
      `Background parallel subagents ${handle.task.id} started (${tasks.length} tasks: ${first.description} et al.).\n` +
      'Use task_output to inspect progress and the final result (block=true waits for completion); you are notified when they finish.',
  };
}

/**
 * 子代理工具（借鉴 Claude Code AgentTool 与 kimi-code 的无状态 loop 复用）：
 * 起一个独立的 runTurn——新消息数组、专用 system prompt（含 cwd，不含 AGENTS.md）、
 * 默认只读工具集。子代理内部事件不进主事件流（UI 只看到 agent 工具本身的开始/结束）；
 * 前台调用父 signal abort 级联到子 loop，返回最后一条 assistant 文本；
 * run_in_background=true 时登记到 TaskManager 立即返回 taskId，缓冲累积流式文本与
 * 工具调用摘要，结束/中断经 task-finished 事件通道通知。
 * tasks 批量模式：多个互相独立的子代理并发执行（各自仍是独立 runTurn，不共享状态），
 * 结果按任务分节聚合；也支持 run_in_background 整体转入后台。
 * 宿主提供 TaskBoard 时：systemPrompt 注入共享证据板纪律段，结论里的 VERIFIED_FACT /
 * DEADEND 行被收割进板；探索烂尾（有工具历史却无文本收官）时自动触发一次
 * 无工具的收尾总结救援（对标 Cairn execute→conclude）。
 */
export function createAgentTool(host: AgentToolHost): Tool {
  return defineTool({
    name: 'agent',
    description: buildDescription(host),
    inputSchema,
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) => {
      if (input.tasks !== undefined && input.tasks.length > 0) {
        return `Agent(×${input.tasks.length} parallel) ${input.tasks[0]!.description} …`;
      }
      const type = input.subagent_type ?? '?';
      const label = input.description ?? '';
      return input.run_in_background === true ? `Agent(bg ${type}) ${label}` : `Agent(${type}) ${label}`;
    },
    call: async (input, ctx) => {
      // tasks 非空 → 批量模式（忽略单发字段）；否则单发模式，三字段缺一不可
      if (input.tasks !== undefined && input.tasks.length > 0) {
        return callBatch(host, input.tasks, input.run_in_background === true, ctx);
      }
      if (
        input.description === undefined ||
        input.prompt === undefined ||
        input.subagent_type === undefined
      ) {
        return {
          output:
            'Single-task mode requires all three fields: description, prompt, and subagent_type. ' +
            'For parallel batches use tasks instead (1-8 { description, prompt, subagent_type } items).',
          isError: true,
        };
      }

      const resolved = resolveSpec(host, input.subagent_type, ctx.cwd);
      if (!resolved.ok) {
        return { output: resolved.error, isError: true };
      }
      const { spec } = resolved;

      const scope = createSubagentScope(host, ctx.cwd);
      const runDeps = {
        host,
        spec,
        type: input.subagent_type,
        prompt: input.prompt,
        cwd: ctx.cwd,
        permission: scope.permission,
      };

      if (input.run_in_background !== true) {
        return runSubagent({
          ...runDeps,
          signal: cascadeSignal(ctx.signal),
          dispatchEvent: scope.makeDispatcher(),
        });
      }

      if (host.tasks === undefined) {
        return {
          output: 'Background subagents are not supported in this environment (no task manager)',
          isError: true,
        };
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
      void runSubagent({ ...runDeps, signal: handle.signal, dispatchEvent: scope.makeDispatcher(sink) })
        .then((result) => {
          // runSubagent 内已收割原文；这里对聚合 output 再收一遍（去重幂等，防截断前缀差异漏收）
          harvestToBoard(host, runDeps.type, result.output);
          handle.appendOutput(`\n--- Final conclusion ---\n${result.output}\n`);
          handle.settle(result.isError === true ? 1 : 0);
        })
        .catch((error: unknown) => {
          handle.appendOutput(`\n[Subagent error] ${errorMessage(error)}`);
          handle.settle(1);
        });
      return {
        output:
          `Background subagent ${handle.task.id} started (${input.subagent_type}: ${input.description}).\n` +
          'Use task_output to inspect progress and the final result (block=true waits for completion); you are notified when it finishes.',
      };
    },
  });
}
