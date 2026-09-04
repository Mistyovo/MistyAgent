import { isContextOverflowError } from '#/provider/errors';
import type {
  ChatProvider,
  FinishReason,
  Message,
  ToolCall,
  ToolDefinition,
  TokenUsage,
} from '#/provider/types';

import { errorMessage } from '../errors';
import type { EventDispatcher } from '../events';

import { chatWithRetry, type ChatWithRetryOptions } from './retry';

export interface ExecuteStepDeps {
  provider: ChatProvider;
  model: string;
  systemPrompt: string;
  messages: readonly Message[];
  /** 传给 provider 的工具定义；传空数组表示本步不允许工具调用 */
  tools: ToolDefinition[];
  step: number;
  signal: AbortSignal;
  dispatchEvent: EventDispatcher;
  retry?: ChatWithRetryOptions | undefined;
  /** 输出 token 上限；length 截断的翻倍升级由 runTurn 负责（重发本步） */
  maxTokens?: number | undefined;
  /** runTurn 的 fallback 链未耗尽：流失败事件标 recoverable（turn 不因此结束） */
  fallbackAvailable?: boolean | undefined;
}

export interface StepOutcome {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: TokenUsage | null;
  finishReason: FinishReason | null;
  /** 流以 error part 结束（重试已耗尽）；此时 toolCalls 可能是残缺的 */
  errored: boolean;
  /** errored 时的错误消息（fallback 事件的 reason） */
  errorMessage?: string | undefined;
  /** 错误为「prompt 超出上下文」类：runTurn 可触发响应式压缩后重试本步 */
  contextOverflow: boolean;
}

interface ToolCallBuffer {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 一次模型采样：流式消费 provider 的 part，边流边 dispatch
 * text-delta / reasoning-delta 事件，最后聚合出完整 toolCalls。
 */
export async function executeStep(deps: ExecuteStepDeps): Promise<StepOutcome> {
  const buffers = new Map<number, ToolCallBuffer>();
  let text = '';
  let reasoning = '';
  let usage: TokenUsage | null = null;
  let finishReason: FinishReason | null = null;
  let errored = false;
  let failureMessage: string | undefined;
  let contextOverflow = false;

  const stream = chatWithRetry(
    deps.provider,
    {
      model: deps.model,
      systemPrompt: deps.systemPrompt,
      messages: [...deps.messages],
      tools: deps.tools,
      maxTokens: deps.maxTokens,
      signal: deps.signal,
    },
    deps.retry,
  );

  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta':
        text += part.text;
        deps.dispatchEvent({ type: 'text-delta', text: part.text });
        break;
      case 'reasoning-delta':
        reasoning += part.text;
        deps.dispatchEvent({ type: 'reasoning-delta', text: part.text });
        break;
      case 'tool-call-start':
        buffers.set(part.index, { id: part.id, name: part.name, arguments: '' });
        break;
      case 'tool-call-delta': {
        const buffer = buffers.get(part.index);
        if (buffer !== undefined) {
          buffer.arguments += part.argumentsDelta;
        }
        break;
      }
      case 'done':
        usage = part.usage;
        finishReason = part.finishReason;
        break;
      case 'error':
        errored = true;
        contextOverflow = isContextOverflowError(part.error);
        failureMessage = errorMessage(part.error);
        deps.dispatchEvent({
          type: 'error',
          message: failureMessage,
          // 溢出/待降级错误可能经 runTurn 恢复；runTurn 放弃时补发 recoverable=false
          recoverable: contextOverflow || deps.fallbackAvailable === true,
        });
        break;
    }
  }

  const toolCalls: ToolCall[] = [...buffers.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, buffer]) => ({ ...buffer }));
  deps.dispatchEvent({ type: 'step-finished', step: deps.step, usage, finishReason });
  return {
    text,
    reasoning,
    toolCalls,
    usage,
    finishReason,
    errored,
    errorMessage: failureMessage,
    contextOverflow,
  };
}
