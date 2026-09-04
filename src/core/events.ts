import type { PermissionMode } from '#/config/schema';
import type { FinishReason, TokenUsage } from '#/provider/types';

import type { ApprovalRequest } from './permission/approval';
import type { PlanApprovalRequest } from './plan-mode';
import type { QuestionRequest } from './question';
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

/** ask_user 工具挂起等用户回答时发出；UI 弹窗后以 question-reply Op 回复 */
export interface QuestionAskedEvent {
  type: 'question-asked';
  request: QuestionRequest;
}

/** exit_plan_mode 工具挂起等用户批准计划时发出；UI 弹窗后以 plan-approval-reply Op 回复 */
export interface PlanApprovalRequestedEvent {
  type: 'plan-approval-requested';
  request: PlanApprovalRequest;
}

/**
 * 进入/退出计划模式时发出（enter_plan_mode / exit_plan_mode 工具、shift+tab、/mode、启动 flag）。
 * mode 为切换后的权限模式：进入恒为 plan；退出为 previousMode（工具批准路径）或用户显式选择的模式。
 */
export interface PlanModeChangedEvent {
  type: 'plan-mode-changed';
  active: boolean;
  mode: PermissionMode;
  /** 进入计划模式前的权限模式（退出后恢复的目标） */
  previousMode?: PermissionMode | undefined;
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

/** 后台任务启动后发出（bash run_in_background）；runningCount 为启动后的运行中任务数 */
export interface TaskStartedEvent {
  type: 'task-started';
  taskId: string;
  command: string;
  pid: number | undefined;
  runningCount: number;
}

/** 后台任务落定（completed/failed/killed）后发出；outputTail 为输出尾部摘要（≤2000 字符） */
export interface TaskFinishedEvent {
  type: 'task-finished';
  taskId: string;
  command: string;
  status: 'completed' | 'failed' | 'killed';
  exitCode: number | null;
  outputTail: string;
  runningCount: number;
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
  | QuestionAskedEvent
  | PlanApprovalRequestedEvent
  | PlanModeChangedEvent
  | CompactedEvent
  | TodosUpdatedEvent
  | TaskStartedEvent
  | TaskFinishedEvent;

export type EventListener = (event: AgentEvent) => void;
export type EventDispatcher = (event: AgentEvent) => void;
