/**
 * 外部世界发给 agent 的指令。M3 会扩展审批类 Op
 * （如 tool-approval-reply），因此 Session 入口按 union 分发而非只收文本。
 */
export interface UserTurnOp {
  type: 'user-turn';
  text: string;
}

export interface InterruptOp {
  type: 'interrupt';
}

export type Op = UserTurnOp | InterruptOp;
