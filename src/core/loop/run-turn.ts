import type { ChatProvider, Message, TokenUsage } from '#/provider/types';

import type { EventDispatcher, TurnStopReason } from '../events';
import { dispatchHookResult, type HookRunner } from '../hooks';
import type { PermissionRuntime } from '../permission/pipeline';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/tool';

import { DoomLoopDetector } from './doom-loop';
import { executeToolCalls } from './tool-scheduler';
import { executeStep, type StepOutcome } from './turn-step';

export interface RunTurnDeps {
  provider: ChatProvider;
  model: string;
  /** 每步从该函数读模型（/model 运行时切换），缺省用 model 字段 */
  getModel?: () => string;
  systemPrompt: string;
  /** 每步从该函数读 system prompt（plan 模式指引可在一个 turn 内被工具切换），缺省用 systemPrompt 字段 */
  getSystemPrompt?: () => string;
  /** 可变历史，loop 直接 append（assistant / tool / 提示消息） */
  messages: Message[];
  /** 历史新增消息时的回调（Session 用于 transcript 落盘） */
  onMessageAppended?: (message: Message) => void;
  /** 每步执行前调用（Session 组装的上下文压缩钩子） */
  maybeCompact?: () => Promise<void>;
  /** context-overflow 错误后的响应式强制压缩（无视阈值）；返回 false 表示压缩未生效 */
  forceCompact?: () => Promise<boolean>;
  tools: Tool[];
  cwd: string;
  maxSteps?: number | undefined;
  signal: AbortSignal;
  dispatchEvent: EventDispatcher;
  permission: PermissionRuntime;
  /** 用户配置的 shell 钩子；缺省不跑 hook */
  hooks?: HookRunner | undefined;
}

export interface RunTurnResult {
  stopReason: TurnStopReason;
  steps: number;
  usage: TokenUsage;
}

const DEFAULT_MAX_STEPS = 50;
/** context-overflow 后的「压缩 + 重试本步」次数上限，防连续溢出死循环 */
const MAX_OVERFLOW_RETRIES = 2;

function addUsage(total: TokenUsage, usage: TokenUsage | null): void {
  if (usage === null) {
    return;
  }
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

/**
 * 中断或出错时丢弃 toolCalls：流被截断后 arguments 可能不完整，
 * 留在历史里会在下一次请求触发 tool_use/tool_result 配对 400。
 */
function appendAssistantMessage(
  push: (message: Message) => void,
  outcome: StepOutcome,
  dropToolCalls: boolean,
): void {
  const toolCalls = dropToolCalls ? [] : outcome.toolCalls;
  if (outcome.text === '' && outcome.reasoning === '' && toolCalls.length === 0) {
    return;
  }
  const message: Message = { role: 'assistant', content: outcome.text };
  if (outcome.reasoning !== '') {
    message.reasoning = outcome.reasoning;
  }
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }
  push(message);
}

/** 给历史里缺 tool_result 的 toolCalls 补合成 isError tool 消息，保证 wire 配对完整 */
function synthesizeMissingToolResults(
  messages: Message[],
  push: (message: Message) => void,
): void {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      answered.add(message.toolCallId);
    }
  }
  for (const message of messages) {
    if (message.role !== 'assistant' || message.toolCalls === undefined) {
      continue;
    }
    for (const toolCall of message.toolCalls) {
      if (!answered.has(toolCall.id)) {
        answered.add(toolCall.id);
        push({
          role: 'tool',
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: 'interrupted by user',
          isError: true,
        });
      }
    }
  }
}

/**
 * turn 级循环：反复 executeStep 直到模型不再调用工具、达到 maxSteps
 * （注入提示消息后以无工具的最后一步收尾）或被中断。
 */
export async function runTurn(deps: RunTurnDeps): Promise<RunTurnResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const registry = new ToolRegistry();
  for (const tool of deps.tools) {
    registry.register(tool);
  }
  const definitions = registry.definitions();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  // doom-loop 检测器是 turn 级的：连续相同工具调用在 scheduler 里被升级为审批
  const doomLoop = new DoomLoopDetector();
  let steps = 0;
  let finalStepForced = false;
  let overflowRetries = 0;

  const pushMessage = (message: Message): void => {
    deps.messages.push(message);
    deps.onMessageAppended?.(message);
  };

  // stop hooks 只在 turn 正常收尾（非中断）时触发；崩溃/超时降级为警告，不阻断收尾
  const finish = async (stopReason: TurnStopReason): Promise<RunTurnResult> => {
    if (stopReason !== 'interrupted' && deps.hooks?.hasHooks('stop') === true) {
      const hookResult = await deps.hooks.run({ event: 'stop', cwd: deps.cwd });
      dispatchHookResult(deps.dispatchEvent, 'stop', hookResult);
    }
    deps.dispatchEvent({ type: 'turn-complete', stopReason, steps, usage });
    return { stopReason, steps, usage };
  };

  const interrupt = async (): Promise<RunTurnResult> => {
    synthesizeMissingToolResults(deps.messages, pushMessage);
    deps.dispatchEvent({ type: 'interrupted', reason: 'user' });
    return finish('interrupted');
  };

  deps.dispatchEvent({ type: 'turn-started' });

  while (true) {
    if (deps.signal.aborted) {
      return interrupt();
    }
    if (steps >= maxSteps && !finalStepForced) {
      pushMessage({
        role: 'user',
        content:
          `已达到最大步数限制（${maxSteps} 步）。请停止调用工具，` +
          '直接总结目前的进展与结论作为收尾。',
      });
      finalStepForced = true;
    }
    await deps.maybeCompact?.();
    if (deps.signal.aborted) {
      return interrupt();
    }
    steps += 1;
    const outcome = await executeStep({
      provider: deps.provider,
      model: deps.getModel?.() ?? deps.model,
      systemPrompt: deps.getSystemPrompt?.() ?? deps.systemPrompt,
      messages: deps.messages,
      tools: finalStepForced ? [] : definitions,
      step: steps,
      signal: deps.signal,
      dispatchEvent: deps.dispatchEvent,
    });
    addUsage(usage, outcome.usage);

    if (outcome.errored) {
      appendAssistantMessage(pushMessage, outcome, true);
      if (outcome.contextOverflow && !deps.signal.aborted) {
        if (overflowRetries < MAX_OVERFLOW_RETRIES) {
          overflowRetries += 1;
          const compacted = (await deps.forceCompact?.()) ?? false;
          if (deps.signal.aborted) {
            return interrupt();
          }
          if (compacted) {
            continue;
          }
        }
        deps.dispatchEvent({
          type: 'error',
          message: '上下文超出模型限制，压缩重试后仍失败',
          recoverable: false,
        });
      }
      return finish('error');
    }
    if (deps.signal.aborted) {
      appendAssistantMessage(pushMessage, outcome, true);
      return interrupt();
    }
    appendAssistantMessage(pushMessage, outcome, false);
    if (finalStepForced || outcome.toolCalls.length === 0) {
      return finish(finalStepForced ? 'max-steps' : 'completed');
    }

    const results = await executeToolCalls(outcome.toolCalls, {
      registry,
      cwd: deps.cwd,
      signal: deps.signal,
      dispatchEvent: deps.dispatchEvent,
      permission: deps.permission,
      doomLoop,
      hooks: deps.hooks,
    });
    for (const { toolCall, result } of results) {
      const message: Message = {
        role: 'tool',
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: result.output,
      };
      if (result.isError === true) {
        message.isError = true;
      }
      pushMessage(message);
    }
  }
}
