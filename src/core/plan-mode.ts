import type { PermissionMode } from '#/config/schema';

/**
 * 计划模式（对标 Claude Code plan mode）：模型/用户进入后只读探索，
 * 模型用 exit_plan_mode 提交计划，经用户批准后退出并执行。
 *
 * 本文件持有三块：挂起-恢复式计划审批（与 QuestionManager 同构）、
 * 计划模式的 system prompt 动态段、工具宿主能力接口。状态机本体在 Session。
 */

export interface PlanApprovalRequest {
  id: string;
  /** exit_plan_mode 提交的 markdown 计划全文 */
  plan: string;
}

export interface PlanApprovalReply {
  approved: boolean;
  /** 拒绝时用户附带的反馈，回喂模型修订计划 */
  feedback?: string;
}

/** 宿主注入给 exit_plan_mode 工具的计划审批能力；signal 来自工具 ctx，abort 时挂起落定拒绝 */
export type RequestPlanApprovalFn = (
  request: PlanApprovalRequest,
  signal: AbortSignal,
) => Promise<PlanApprovalReply>;

/** enter_plan_mode / exit_plan_mode 工具的宿主能力，registry 创建时闭包注入（Session 天然满足该接口） */
export interface PlanModeHost {
  isPlanMode(): boolean;
  /** 返回 false 表示已在计划模式中（幂等） */
  enterPlanMode(): boolean;
  /** target 缺省切回进入前的模式；返回 false 表示不在计划模式中 */
  exitPlanMode(target?: PermissionMode): boolean;
  requestPlanApproval(request: PlanApprovalRequest, signal: AbortSignal): Promise<PlanApprovalReply>;
}

interface PendingPlanApproval {
  settle: (reply: PlanApprovalReply) => void;
}

const interruptedReply: PlanApprovalReply = { approved: false, feedback: 'interrupted by user' };

export class PlanApprovalManager {
  private readonly pending = new Map<string, PendingPlanApproval>();
  private requestedListener: ((request: PlanApprovalRequest) => void) | null = null;

  /** Session 订阅后转发为 plan-approval-requested 事件；单订阅者（事件流只有一个） */
  onRequested(listener: (request: PlanApprovalRequest) => void): void {
    this.requestedListener = listener;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request(request: PlanApprovalRequest, signal?: AbortSignal): Promise<PlanApprovalReply> {
    if (this.pending.has(request.id)) {
      return Promise.resolve({ approved: false, feedback: `重复的计划审批请求 id：${request.id}` });
    }
    if (signal?.aborted === true) {
      return Promise.resolve(interruptedReply);
    }
    return new Promise((resolve) => {
      const settle = (reply: PlanApprovalReply): void => {
        this.pending.delete(request.id);
        signal?.removeEventListener('abort', onAbort);
        resolve(reply);
      };
      const onAbort = (): void => {
        settle(interruptedReply);
      };
      // 先注册挂起再通知：监听器可以在通知回调里同步回复
      this.pending.set(request.id, { settle });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.requestedListener?.(request);
    });
  }

  /** 返回 false 表示没有该 id 的挂起审批（迟到或重复的回复） */
  reply(id: string, reply: PlanApprovalReply): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return false;
    }
    entry.settle(reply);
    return true;
  }

  cancelAll(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.settle(interruptedReply);
    }
  }
}

/** 计划模式的 system prompt 动态段：每步组装（plan 状态可在一个 turn 内被工具改变） */
export function buildPlanModePrompt(): string {
  return [
    '当前处于计划模式（plan mode）：先只读探索，再提交计划。',
    '- 只能使用只读工具（read / glob / grep / web_search / web_fetch 等）；write / edit / bash 等写/执行类调用会被权限直接拒绝，不要尝试。',
    '- 充分调研后，调用 exit_plan_mode 提交完整的实施计划（markdown：改哪些文件、做什么、按什么顺序、如何验证）。',
    '- 用户批准后自动退出计划模式，随后按计划执行；被拒绝时按反馈修订计划，再次调用 exit_plan_mode 提交。',
    '- 不要重复调用 enter_plan_mode（已在计划模式中）。',
  ].join('\n');
}
