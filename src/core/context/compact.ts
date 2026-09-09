import type { ChatProvider, Message } from '#/provider/types';

import { displayPath, resolvePath } from '../tools/builtin/fs-utils';
import { readTool } from '../tools/builtin/read';

export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
/** 估算 token 超过 maxContextTokens × 阈值时触发压缩 */
export const COMPACT_THRESHOLD_RATIO = 0.8;
const DEFAULT_KEEP_RECENT = 4;
/** 压缩后回注的最近 read 文件数上限 */
const REINJECT_MAX_FILES = 5;
/** 回注内容总字符数上限（超出丢弃更旧的文件） */
const REINJECT_MAX_TOTAL_CHARS = 20_000;
/** 每条消息的固定开销（role、分隔等 wire 结构） */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;
/** 粗估：ASCII 4 字符 ≈ 1 token，CJK 等宽字符 1 字符 ≈ 1 token */
const ASCII_CHARS_PER_TOKEN = 4;
/** 摘要请求历史窗口的预算占比；余量留给 system prompt、摘要输出与估算误差 */
const SUMMARY_WINDOW_BUDGET_RATIO = 0.5;
/** 省略概况中列出的最近 read 文件数上限 */
const DIGEST_MAX_READ_PATHS = 10;

/** 分段粗估：宽字符（CJK 等）1 字符 ≈ 1 token，ASCII 4 字符 ≈ 1 token */
function estimateTextTokens(text: string): number {
  let wide = 0;
  let ascii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 0x80) {
      ascii += 1;
    } else {
      wide += 1;
    }
  }
  return wide + Math.ceil(ascii / ASCII_CHARS_PER_TOKEN);
}

export function estimateTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    let tokens = PER_MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content);
    if (message.role === 'assistant') {
      // reasoning 不回传 API（端点会拒绝该字段），不计入
      for (const call of message.toolCalls ?? []) {
        tokens += estimateTextTokens(call.name) + estimateTextTokens(call.arguments);
      }
    }
    total += tokens;
  }
  return total;
}

const SUMMARY_PROMPT_BODY = [
  'Produce a concise summary in the user\'s language. It replaces the raw history as the sole context for the rest of the conversation, so it must preserve:',
  '1) The goal of the conversation, plus every constraint, preference, and correction the user gave (the places where the user corrected you matter most);',
  '2) The work completed and the key decisions with their rationale;',
  '3) The key files involved and what changed in each;',
  '4) Verified facts and ruled-out directions (which verification commands were run and what they returned);',
  '5) Outstanding items and the next steps.',
  'Keep only what is useful for continuing the work; do not restate raw tool output.',
].join('\n');

const SUMMARY_PROMPT = `The above is the complete conversation history of the current session. ${SUMMARY_PROMPT_BODY}`;

/** 历史被截窗时改用：说明窗口外还有被省略的早期部分 */
const SUMMARY_PROMPT_WINDOWED = `The above is the newer part of the session history (earlier parts were omitted; a digest is in the message before it). ${SUMMARY_PROMPT_BODY}`;

const SUMMARIZER_SYSTEM_PROMPT =
  'You are a conversation summarizer. Produce a concise, accurate summary in the same language as the conversation.';

export interface CompactResult {
  beforeCount: number;
  afterCount: number;
  beforeTokens: number;
  afterTokens: number;
}

export interface CompactOptions {
  provider: ChatProvider;
  model: string;
  /** 可变历史；压缩成功时原地重建为「摘要 + 回注文件 + 最近 keepRecent 条」 */
  messages: Message[];
  keepRecent?: number;
  /** 提供后压缩时回注最近 read 过的文件当前内容（路径相对 cwd 解析） */
  cwd?: string | undefined;
  /** 摘要请求的输入预算基准；缺省取 DEFAULT_MAX_CONTEXT_TOKENS */
  maxContextTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

function readPathFromArguments(args: string): string | null {
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === 'object' && parsed !== null) {
      const path = (parsed as { path?: unknown }).path;
      if (typeof path === 'string' && path !== '') {
        return path;
      }
    }
  } catch {
    // arguments 残缺/非法 JSON：跳过
  }
  return null;
}

/**
 * 提取最近成功 read 过的文件路径，最新在前、去重、封顶 maxFiles 个。
 * input 存在于 assistant 消息的 toolCalls.arguments 里（tool 消息只有结果），
 * 结果带 isError 的调用不算「读过」。
 */
export function extractRecentReadFiles(
  messages: readonly Message[],
  maxFiles = REINJECT_MAX_FILES,
): string[] {
  const errored = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.isError === true) {
      errored.add(message.toolCallId);
    }
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let index = messages.length - 1; index >= 0 && paths.length < maxFiles; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || message.toolCalls === undefined) {
      continue;
    }
    for (let c = message.toolCalls.length - 1; c >= 0 && paths.length < maxFiles; c -= 1) {
      const call = message.toolCalls[c]!;
      if (call.name !== 'read' || errored.has(call.id)) {
        continue;
      }
      const path = readPathFromArguments(call.arguments);
      if (path !== null && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

/**
 * 重新读取压缩前读过的文件当前内容，组装为 user 上下文消息。
 * paths 最新在前（预算不足时优先保留最新的）；返回的消息反转为时间序，
 * 使最新的文件贴近保留的尾部。文件读不到则跳过。
 */
async function buildReinjectionMessages(
  paths: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<Message[]> {
  const ctx = { cwd, signal: signal ?? new AbortController().signal };
  const messages: Message[] = [];
  let remaining = REINJECT_MAX_TOTAL_CHARS;
  for (const path of paths) {
    if (remaining <= 0) {
      break;
    }
    const result = await readTool.call({ path }, ctx);
    if (result.isError === true) {
      continue;
    }
    const shown = displayPath(cwd, resolvePath(cwd, path));
    let body = result.output;
    if (body.length > remaining) {
      if (messages.length > 0) {
        break;
      }
      body = `${body.slice(0, remaining)}\n[Re-injection budget exceeded, content truncated]`;
    }
    const header = `[File read just before compaction, reloaded with its current content for reference: ${shown}]`;
    messages.push({ role: 'user', content: `${header}\n${body}` });
    remaining -= header.length + 1 + body.length;
  }
  return messages.toReversed();
}

/**
 * 截取进入摘要请求的历史尾部：从最新向前累计估算 token，超预算即止，
 * 保证历史已硬溢出时摘要请求自身不溢出。窗口若以 tool 消息开头则一并丢弃
 * （其 assistant 调用已出窗，留着会触发 wire 配对 400）。
 */
function buildSummaryWindow(
  messages: readonly Message[],
  budgetTokens: number,
): { kept: Message[]; dropped: Message[] } {
  let start = messages.length;
  let used = 0;
  while (start > 0) {
    const cost = estimateTokens([messages[start - 1]!]);
    if (used + cost > budgetTokens) {
      break;
    }
    used += cost;
    start -= 1;
  }
  while (start < messages.length && messages[start]!.role === 'tool') {
    start += 1;
  }
  return { kept: messages.slice(start), dropped: messages.slice(0, start) };
}

/** 被省略的早期历史概况：供摘要模型了解出窗部分涉及的工具与文件 */
function buildDroppedDigest(dropped: readonly Message[]): Message {
  const toolCounts = new Map<string, number>();
  for (const message of dropped) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
    }
  }
  const readPaths = extractRecentReadFiles(dropped, DIGEST_MAX_READ_PATHS);
  const lines = [
    `[${dropped.length} earlier history messages were omitted because they exceeded the summary budget; only this digest is attached]`,
  ];
  if (toolCounts.size > 0) {
    lines.push(
      `Tool calls: ${[...toolCounts].map(([name, count]) => `${name}×${count}`).join(', ')}`,
    );
  }
  if (readPaths.length > 0) {
    lines.push(`Recently read files: ${readPaths.join(', ')}`);
  }
  return { role: 'user', content: lines.join('\n') };
}

/**
 * 用 provider 生成历史摘要；流出错/中断/空摘要返回 null。
 * 历史可能已硬超上下文（响应式压缩），故只送按预算截取的尾部窗口，
 * 被省略部分附工具/文件概况，保证摘要请求自身不溢出。
 */
async function summarize(options: CompactOptions): Promise<string | null> {
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const budget = Math.floor(maxContextTokens * SUMMARY_WINDOW_BUDGET_RATIO);
  const { kept, dropped } = buildSummaryWindow(options.messages, budget);
  const requestMessages: Message[] = [
    ...(dropped.length > 0 ? [buildDroppedDigest(dropped)] : []),
    ...kept,
    { role: 'user', content: dropped.length > 0 ? SUMMARY_PROMPT_WINDOWED : SUMMARY_PROMPT },
  ];
  const stream = options.provider.generate({
    model: options.model,
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    messages: requestMessages,
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
 * 压缩历史：摘要作为一条 user 消息 + （提供 cwd 时）回注最近 read 文件的当前内容
 * + 保留最近 keepRecent 条原消息。
 * 尾部若以 tool 消息开头则丢弃（其 assistant 调用已出窗，留着会触发 wire 配对 400）。
 * 任何失败返回 null，历史保持原样。
 */
export async function compactHistory(options: CompactOptions): Promise<CompactResult | null> {
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  if (options.messages.length <= keepRecent) {
    return null;
  }
  const cwd = options.cwd;
  const beforeCount = options.messages.length;
  const beforeTokens = estimateTokens(options.messages);
  // 在摘要生成前从原历史提取（重建后这些 read 调用已出窗）
  const readFiles = cwd !== undefined ? extractRecentReadFiles(options.messages) : [];
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
  const summaryMessage: Message = { role: 'user', content: `[Conversation history summary]\n${summary}` };
  const reinjected =
    cwd !== undefined && readFiles.length > 0
      ? await buildReinjectionMessages(readFiles, cwd, options.signal)
      : [];
  options.messages.splice(0, options.messages.length, summaryMessage, ...reinjected, ...tail);
  return {
    beforeCount,
    afterCount: options.messages.length,
    beforeTokens,
    afterTokens: estimateTokens(options.messages),
  };
}

export interface MaybeCompactOptions extends CompactOptions {
  maxContextTokens: number;
  /** true 时无视阈值强制压缩（context-overflow 错误后的响应式重试） */
  force?: boolean | undefined;
}

/** 阈值触发的自动压缩；未达阈值返回 null（不消耗 provider 调用） */
export async function maybeCompactHistory(options: MaybeCompactOptions): Promise<CompactResult | null> {
  if (
    options.force !== true &&
    estimateTokens(options.messages) <= options.maxContextTokens * COMPACT_THRESHOLD_RATIO
  ) {
    return null;
  }
  return compactHistory(options);
}

export function isOverCompactThreshold(
  messages: readonly Message[],
  maxContextTokens: number,
): boolean {
  return estimateTokens(messages) > maxContextTokens * COMPACT_THRESHOLD_RATIO;
}

/** 微压缩尾部保护窗口：最近 N 条消息不修剪（模型正在盯着的内容） */
const PRUNE_KEEP_RECENT_MESSAGES = 12;
/** 单条工具输出进入修剪的最小字符数 */
const PRUNE_MIN_OUTPUT_CHARS = 3000;
const PRUNE_MARK = '[This tool output was pruned to free context';

export interface PruneResult {
  prunedCount: number;
  beforeTokens: number;
  afterTokens: number;
}

export interface PruneOptions {
  /** 尾部保护窗口（最近 N 条消息不修剪），默认 12 */
  keepRecentMessages?: number;
  /** 单条输出进入修剪的最小字符数，默认 3000 */
  minOutputChars?: number;
  /** 全量输出落盘（返回路径，写进占位符）；缺省只留占位符 */
  spill?: (output: string) => string | null;
}

/**
 * 微压缩（microcompaction）：把保护窗口外的超长 tool 输出原地替换为占位符
 * （提供 spill 时全量落盘并在占位符附路径）。不调 LLM、幂等、可反复触发；
 * 阈值触发的全量压缩前先试这一步，多数长会话靠它即可回到阈值内。
 * 没有可修剪目标返回 null。只改 tool 消息的 content，wire 配对不受影响。
 */
export function pruneStaleToolOutputs(
  messages: Message[],
  options: PruneOptions = {},
): PruneResult | null {
  const keep = options.keepRecentMessages ?? PRUNE_KEEP_RECENT_MESSAGES;
  const minChars = options.minOutputChars ?? PRUNE_MIN_OUTPUT_CHARS;
  const beforeTokens = estimateTokens(messages);
  let prunedCount = 0;
  const cutoff = messages.length - keep;
  for (let index = 0; index < cutoff; index += 1) {
    const message = messages[index]!;
    if (
      message.role !== 'tool' ||
      message.content.length < minChars ||
      message.content.startsWith(PRUNE_MARK)
    ) {
      continue;
    }
    const spilled = options.spill?.(message.content) ?? null;
    message.content =
      `${PRUNE_MARK}: was ${message.content.length} characters` +
      (spilled !== null ? `; the full output is on disk at ${spilled}]` : ']');
    prunedCount += 1;
  }
  if (prunedCount === 0) {
    return null;
  }
  return { prunedCount, beforeTokens, afterTokens: estimateTokens(messages) };
}
