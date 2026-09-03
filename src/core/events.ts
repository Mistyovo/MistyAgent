import type { FinishReason, TokenUsage } from '#/provider/types';

import type { ApprovalRequest } from './permission/approval';
import type { TodoItem } from './todos';

export interface TurnStartedEvent {
  type: 'turn-started';
}

export interface TurnCompleteEvent {
  type: 'turn-complete';
  stopReason: TurnStopReason;
  steps: number;
  usage: TokenUsage;
}

export type TurnStopReason = 'completed' | 'interrupted' | 'max-steps' | 'error';

export interface TextDeltaEvent {
  type: 'text-delta';
  text: string;
}

export interface ReasoningDeltaEvent {
  type: 'reasoning-delta';
  text: string;
}

/** 工具开始执行时发出；input 为解析后的参数快照（JSON 解析失败时为原始字符串） */
export interface ToolCallStartedEvent {
  type: 'tool-call-started';
  toolCallId: string;
  name: string;
  input: unknown;
}

export interface ToolCallCompletedEvent {
  type: 'tool-call-completed';
  toolCallId: string;
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
  durationMs: number;
}

/** 一次模型采样结束；usage 在 provider 未上报时为 null */
export interface StepFinishedEvent {
  type: 'step-finished';
  step: number;
  usage: TokenUsage | null;
  finishReason: FinishReason | null;
}

/** recoverable=false 表示 turn 因此结束 */
export interface ErrorEvent {
  type: 'error';
  message: string;
  recoverable: boolean;
}

export interface InterruptedEvent {
  type: 'interrupted';
  reason: 'user';
}

/** 工具调用需要用户审批时发出；UI 弹窗后以 approval-reply Op 回复 */
export interface ApprovalRequestedEvent {
  type: 'approval-requested';
  request: ApprovalRequest;
}

/** 上下文压缩完成（自动或 /compact 手动触发）后发出 */
export interface CompactedEvent {
  type: 'compacted';
  /** 压缩前历史消息数 */
  beforeCount: number;
  /** 压缩后历史消息数（摘要 + 保留的尾部） */
  afterCount: number;
  beforeTokens: number;
  afterTokens: number;
}

/** todo 工具全量替换任务列表后发出，携带最新全量 todos */
export interface TodosUpdatedEvent {
  type: 'todos-updated';
  todos: TodoItem[];
}

export type AgentEvent =
  | TurnStartedEvent
  | TurnCompleteEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartedEvent
  | ToolCallCompletedEvent
  | StepFinishedEvent
  | ErrorEvent
  | InterruptedEvent
  | ApprovalRequestedEvent
  | CompactedEvent
  | TodosUpdatedEvent;

export type EventListener = (event: AgentEvent) => void;
export type EventDispatcher = (event: AgentEvent) => void;
