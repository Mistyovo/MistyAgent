import type { ChatProvider, Message } from '#/provider/types';

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
/** 估算 token 超过 maxContextTokens × 阈值时触发压缩 */
const COMPACT_THRESHOLD_RATIO = 0.8;
const DEFAULT_KEEP_RECENT = 4;
/** 每条消息的固定开销（role、分隔等 wire 结构） */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;
/** 粗估：4 字符 ≈ 1 token */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    let chars = message.content.length;
    if (message.role === 'assistant') {
      chars += message.reasoning?.length ?? 0;
      for (const call of message.toolCalls ?? []) {
        chars += call.name.length + call.arguments.length;
      }
    }
    total += PER_MESSAGE_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN);
  }
  return total;
}

const SUMMARY_PROMPT = [
  '以上是当前会话的完整对话历史。请用中文输出一份简洁摘要，覆盖：',
  '1）对话目标；2）已完成的工作；3）涉及的关键文件；4）待办事项。',
  '该摘要将替代原始历史作为后续对话的上下文，请保留关键事实。',
].join('\n');

const SUMMARIZER_SYSTEM_PROMPT = '你是对话摘要助手，输出简洁、准确的中文摘要。';

export interface CompactResult {
  beforeCount: number;
  afterCount: number;
  beforeTokens: number;
  afterTokens: number;
}

export interface CompactOptions {
  provider: ChatProvider;
  model: string;
  /** 可变历史；压缩成功时原地重建为「摘要 + 最近 keepRecent 条」 */
  messages: Message[];
  keepRecent?: number;
  signal?: AbortSignal | undefined;
}

/** 用 provider 生成历史摘要；流出错/中断/空摘要返回 null */
async function summarize(options: CompactOptions): Promise<string | null> {
  const stream = options.provider.generate({
    model: options.model,
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    messages: [...options.messages, { role: 'user', content: SUMMARY_PROMPT }],
    tools: [],
    signal: options.signal,
  });
  let text = '';
  for await (const part of stream) {
    if (part.type === 'text-delta') {
      text += part.text;
    } else if (part.type === 'error') {
      return null;
    }
  }
  return text === '' || options.signal?.aborted === true ? null : text;
}

/**
 * 压缩历史：摘要作为一条 user 消息 + 保留最近 keepRecent 条原消息。
 * 尾部若以 tool 消息开头则丢弃（其 assistant 调用已出窗，留着会触发 wire 配对 400）。
 * 任何失败返回 null，历史保持原样。
 */
export async function compactHistory(options: CompactOptions): Promise<CompactResult | null> {
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  if (options.messages.length <= keepRecent) {
    return null;
  }
  const beforeCount = options.messages.length;
  const beforeTokens = estimateTokens(options.messages);
  let summary: string | null;
  try {
    summary = await summarize(options);
  } catch {
    return null;
  }
  if (summary === null) {
    return null;
  }
  const tail = options.messages.slice(-keepRecent);
  while (tail.length > 0 && tail[0]?.role === 'tool') {
    tail.shift();
  }
  const summaryMessage: Message = { role: 'user', content: `[历史对话摘要]\n${summary}` };
  options.messages.splice(0, options.messages.length, summaryMessage, ...tail);
  return {
    beforeCount,
    afterCount: options.messages.length,
    beforeTokens,
    afterTokens: estimateTokens(options.messages),
  };
}

export interface MaybeCompactOptions extends CompactOptions {
  maxContextTokens: number;
}

/** 阈值触发的自动压缩；未达阈值返回 null（不消耗 provider 调用） */
export async function maybeCompactHistory(options: MaybeCompactOptions): Promise<CompactResult | null> {
  if (estimateTokens(options.messages) <= options.maxContextTokens * COMPACT_THRESHOLD_RATIO) {
    return null;
  }
  return compactHistory(options);
}
