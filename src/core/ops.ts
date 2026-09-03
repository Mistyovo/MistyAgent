import type { ApprovalReply } from './permission/approval';

/**
 * 外部世界发给 agent 的指令。Session 入口按 union 分发：
 * user-turn 走 turn 队列，approval-reply 直接转发 ApprovalManager。
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

export type Op = UserTurnOp | InterruptOp | ApprovalReplyOp;
