import { randomUUID } from 'node:crypto';

import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions';
import type { Stream } from 'openai/streaming';

import { ContextOverflowError } from '#/provider/errors';
import type {
  ChatParams,
  ChatProvider,
  FinishReason,
  Message,
  StreamedMessagePart,
  TokenUsage,
} from '#/provider/types';

import { extractReasoning } from './reasoning';

export interface OpenAIChatProviderOptions {
  apiKey: string;
  baseURL?: string | undefined;
  /** 钉死 reasoning 字段名，跳过自动探测 */
  reasoningKey?: string | undefined;
}

export interface ConvertStreamOptions {
  reasoningKey?: string | undefined;
}

interface ToolCallBuffer {
  id?: string;
  arguments: string;
  started: boolean;
}

function normalizeFinishReason(raw: string | null): FinishReason | null {
  if (raw === null) {
    return null;
  }
  switch (raw) {
    case 'stop':
      return 'completed';
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'other';
  }
}

function normalizeUsage(usage: ChatCompletionChunk['usage']): TokenUsage | null {
  if (usage === undefined || usage === null) {
    return null;
  }
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

const CONTEXT_OVERFLOW_MESSAGE_PATTERN =
  /context length|maximum context|context window|too long|too many tokens|request entity too large|reduce the length/i;

/**
 * 识别「prompt 超出上下文」类端点错误：HTTP 413、error.code 为 context_length_exceeded，
 * 或 400 且 message 命中常见表述。命中时规整为 ContextOverflowError，供 loop 层压缩重试。
 */
export function classifyContextOverflow(error: unknown): ContextOverflowError | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  const matched =
    status === 413 ||
    code === 'context_length_exceeded' ||
    (status === 400 &&
      CONTEXT_OVERFLOW_MESSAGE_PATTERN.test(
        error instanceof Error ? error.message : String(error),
      ));
  if (!matched) {
    return null;
  }
  return new ContextOverflowError(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

/**
 * 把 chat completions 的 SSE chunk 流转换为统一的 StreamedMessagePart 流。
 * 与 SDK 解耦的纯函数，测试直接喂 fake chunk 序列。
 *
 * tool-call 重组：delta 按 index 聚合；id/name 可能只在首个 chunk 出现，
 * arguments 分片追加。name 未到时先到的 arguments 会缓冲，见到 name 时
 * 先 emit tool-call-start，再把缓冲内容作为 tool-call-delta 冲出。
 */
export async function* convertChatCompletionStream(
  chunks: AsyncIterable<ChatCompletionChunk>,
  options?: ConvertStreamOptions,
): AsyncGenerator<StreamedMessagePart, void, unknown> {
  const toolCallBuffers = new Map<number, ToolCallBuffer>();
  let rawFinishReason: string | null = null;
  let usage: ChatCompletionChunk['usage'];

  for await (const chunk of chunks) {
    for (const choice of chunk.choices) {
      if (choice.index !== 0) {
        continue;
      }
      const delta = choice.delta;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text-delta', text: delta.content };
      }
      const reasoning = extractReasoning(delta, options?.reasoningKey);
      if (reasoning !== undefined && reasoning.value.length > 0) {
        yield { type: 'reasoning-delta', text: reasoning.value };
      }
      for (const toolCall of delta.tool_calls ?? []) {
        const index = toolCall.index;
        let buffer = toolCallBuffers.get(index);
        if (buffer === undefined) {
          buffer = { arguments: '', started: false };
          toolCallBuffers.set(index, buffer);
        }
        if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
          buffer.id = toolCall.id;
        }
        const name = toolCall.function?.name;
        const args = toolCall.function?.arguments;
        if (!buffer.started) {
          if (typeof name === 'string' && name.length > 0) {
            buffer.started = true;
            yield { type: 'tool-call-start', index, id: buffer.id ?? randomUUID(), name };
            const initial = buffer.arguments + (args ?? '');
            buffer.arguments = '';
            if (initial.length > 0) {
              yield { type: 'tool-call-delta', index, argumentsDelta: initial };
            }
          } else if (typeof args === 'string' && args.length > 0) {
            buffer.arguments += args;
          }
        } else if (typeof args === 'string' && args.length > 0) {
          yield { type: 'tool-call-delta', index, argumentsDelta: args };
        }
      }
      if (choice.finish_reason !== null) {
        rawFinishReason = choice.finish_reason;
      }
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = chunk.usage;
    }
  }

  yield {
    type: 'done',
    usage: normalizeUsage(usage),
    finishReason: normalizeFinishReason(rawFinishReason),
    rawFinishReason,
  };
}

function toOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        result.push({ role: 'system', content: message.content });
        break;
      case 'user':
        result.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        // reasoning 不回传：DeepSeek 等端点会拒绝带 reasoning 字段的输入消息
        const param: ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: message.content,
        };
        if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
          param.tool_calls = message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function' as const,
            function: { name: toolCall.name, arguments: toolCall.arguments },
          }));
        }
        result.push(param);
        break;
      }
      case 'tool':
        // isError 无法表达在 wire 上，由 content 文本承载
        result.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.content,
        });
        break;
    }
  }
  return result;
}

/** o 系列与 gpt-5 系列只认 max_completion_tokens，其余端点用 max_tokens */
function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

function toOpenAITools(tools: ChatParams['tools']): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export class OpenAIChatProvider implements ChatProvider {
  private readonly client: OpenAI;
  private readonly reasoningKey: string | undefined;

  constructor(options: OpenAIChatProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
    this.reasoningKey = options.reasoningKey;
  }

  async *generate(params: ChatParams): AsyncGenerator<StreamedMessagePart, void, unknown> {
    const request: ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: toOpenAIMessages(params.systemPrompt, params.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (params.tools.length > 0) {
      request.tools = toOpenAITools(params.tools);
    }
    if (params.maxTokens !== undefined) {
      if (usesMaxCompletionTokens(params.model)) {
        request.max_completion_tokens = params.maxTokens;
      } else {
        request.max_tokens = params.maxTokens;
      }
    }
    if (params.temperature !== undefined) {
      request.temperature = params.temperature;
    }

    let stream: Stream<ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(request, { signal: params.signal });
    } catch (error) {
      if (params.signal?.aborted === true) {
        return;
      }
      yield { type: 'error', error: classifyContextOverflow(error) ?? error };
      return;
    }

    try {
      yield* convertChatCompletionStream(stream, { reasoningKey: this.reasoningKey });
    } catch (error) {
      // abort 时优雅结束：不再产出任何 part
      if (params.signal?.aborted === true) {
        return;
      }
      yield { type: 'error', error: classifyContextOverflow(error) ?? error };
    }
  }
}
