import type { ApprovalReply } from './permission/approval';
import type { PlanApprovalReply } from './plan-mode';
import type { QuestionReply } from './question';

/**
 * 外部世界发给 agent 的指令。Session 入口按 union 分发：
 * user-turn 走 turn 队列，approval-reply / question-reply / plan-approval-reply
 * 直接转发对应 Manager。
 */
export interface UserTurnOp {
  type: 'user-turn';
  text: string;
}

export interface InterruptOp {
  type: 'interrupt';
}

export interface ApprovalReplyOp {
  type: 'approval-reply';
  /** 对应 ApprovalRequest.id（= toolCallId） */
  id: string;
  reply: ApprovalReply;
}

export interface QuestionReplyOp {
  type: 'question-reply';
  /** 对应 QuestionRequest.id */
  id: string;
  reply: QuestionReply;
}

export interface PlanApprovalReplyOp {
  type: 'plan-approval-reply';
  /** 对应 PlanApprovalRequest.id */
  id: string;
  reply: PlanApprovalReply;
}

export type Op = UserTurnOp | InterruptOp | ApprovalReplyOp | QuestionReplyOp | PlanApprovalReplyOp;
