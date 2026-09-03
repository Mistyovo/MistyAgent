export interface ToolCall {
  id: string;
  name: string;
  /** JSON 序列化后的参数字符串 */
  arguments: string;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 对象；从 zod schema 转换是调用方的责任 */
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason =
  | 'completed'
  | 'tool-calls'
  | 'length'
  | 'content-filter'
  | 'error'
  | 'other';

export interface TextDeltaPart {
  type: 'text-delta';
  text: string;
}

export interface ReasoningDeltaPart {
  type: 'reasoning-delta';
  text: string;
}

export interface ToolCallStartPart {
  type: 'tool-call-start';
  index: number;
  id: string;
  name: string;
}

export interface ToolCallDeltaPart {
  type: 'tool-call-delta';
  index: number;
  argumentsDelta: string;
}

/**
 * 流正常结束时恰好发出一次。provider 未上报 finish_reason（如流被截断）
 * 时 finishReason 为 null；rawFinishReason 保留原始 wire 值。
 */
export interface DonePart {
  type: 'done';
  usage: TokenUsage | null;
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
}

/** 流失败时作为最后一个 part 发出，之后流结束（不再发 done） */
export interface ErrorPart {
  type: 'error';
  error: unknown;
}

export type StreamedMessagePart =
  | TextDeltaPart
  | ReasoningDeltaPart
  | ToolCallStartPart
  | ToolCallDeltaPart
  | DonePart
  | ErrorPart;

export interface ChatParams {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChatProvider {
  generate(params: ChatParams): AsyncIterable<StreamedMessagePart>;
}
