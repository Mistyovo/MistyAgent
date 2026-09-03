import { platform } from 'node:os';

import { z } from 'zod';

import type { ChatProvider, Message } from '#/provider/types';

import { runTurn } from '../../loop/run-turn';
import { createPermissionRuntime } from '../../permission/pipeline';
import { defineTool, type Tool } from '../tool';

import { truncate } from './fs-utils';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';

const SUBAGENT_MAX_STEPS = 30;
const MAX_OUTPUT_CHARS = 30_000;

const subagentTypeSchema = z.enum(['explore', 'plan']);

const inputSchema = z.object({
  description: z.string().describe('一句话描述这个子任务'),
  prompt: z.string().describe('交给子代理的完整任务描述（它看不到主会话历史，必须自包含）'),
  subagent_type: subagentTypeSchema.describe('explore：代码探索；plan：输出实现计划'),
});

/** 子代理只读工具集：天然规避子代理内无法弹审批的问题 */
const SUBAGENT_TOOLS: Tool[] = [readTool, globTool, grepTool];

/** 创建 agent 工具所需的宿主能力，registry 创建时闭包注入 */
export interface AgentToolHost {
  provider: ChatProvider;
  /** 每次调用取当前模型，/model 运行时切换对后续子代理生效 */
  getModel: () => string;
}

const ROLE_PROMPTS: Record<z.output<typeof subagentTypeSchema>, string> = {
  explore:
    '你是代码探索子代理。用只读工具（read / glob / grep）在代码库中定位与任务相关的实现，' +
    '输出结论：涉及的文件与行号、关键逻辑摘要、与任务相关的发现。',
  plan:
    '你是实现规划子代理。用只读工具（read / glob / grep）了解代码现状，' +
    '输出一份可执行的实现计划：分步动作、涉及的文件、风险与验证方式。',
};

function buildSubagentPrompt(type: z.output<typeof subagentTypeSchema>, cwd: string): string {
  const environment =
    platform() === 'win32' ? '运行环境为 Windows。' : `运行环境：${platform()}。`;
  return [
    ROLE_PROMPTS[type],
    '不要修改任何文件；你没有交互能力，直接给出最终结论文本。',
    '',
    `当前工作目录：${cwd}（工具调用中的相对路径都相对它解析）。`,
    environment,
  ].join('\n');
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

/**
 * 子代理工具（借鉴 Claude Code AgentTool 与 kimi-code 的无状态 loop 复用）：
 * 起一个独立的 runTurn——新消息数组、专用 system prompt（含 cwd，不含 AGENTS.md）、
 * 只读工具集、bypassPermissions 权限（只读工具本就自动放行）。子代理内部事件不进
 * 主事件流（UI 只看到 agent 工具本身的开始/结束）；父 signal abort 级联到子 loop。
 * 返回子代理最后一条 assistant 文本作为工具 output。
 */
export function createAgentTool(host: AgentToolHost): Tool {
  return defineTool({
    name: 'agent',
    description:
      '启动一个子代理处理独立子任务（只读：read / glob / grep）。' +
      'explore 用于代码探索与定位，plan 用于产出现状分析与实现计划。' +
      '子代理看不到本会话历史，prompt 必须自包含；返回其最终结论文本。',
    inputSchema,
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) => `Agent(${input.subagent_type}) ${input.description}`,
    call: async (input, ctx) => {
      // 中断级联：父 signal abort → 子 loop abort
      const controller = new AbortController();
      if (ctx.signal.aborted) {
        controller.abort();
      } else {
        ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      const messages: Message[] = [{ role: 'user', content: input.prompt }];
      const result = await runTurn({
        provider: host.provider,
        model: host.getModel(),
        systemPrompt: buildSubagentPrompt(input.subagent_type, ctx.cwd),
        messages,
        tools: SUBAGENT_TOOLS,
        cwd: ctx.cwd,
        maxSteps: SUBAGENT_MAX_STEPS,
        signal: controller.signal,
        dispatchEvent: () => {},
        permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd: ctx.cwd }),
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
    },
  });
}
