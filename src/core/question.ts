/**
 * 挂起-恢复式提问（与 ApprovalManager 同构）：ask_user 工具在 call 内调 ask()
 * 挂起，UI 侧经 question-reply Op 调 reply() 兑现；interrupt 时 cancelAll()
 * 把所有挂起落定 cancelled。ask 先于 onAsked 通知注册挂起，监听器可以在
 * 通知回调里同步回复。
 */

export interface QuestionOption {
  label: string;
  description?: string | undefined;
}

export interface QuestionRequest {
  id: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean | undefined;
}

/** cancelled 表示用户跳过/拒绝回答（或无头模式、中断落定） */
export type QuestionReply = { answers: string[] } | { cancelled: true };

/** 宿主注入给 ask_user 工具的提问能力；signal 来自工具 ctx，abort 时挂起落定 cancelled */
export type AskUserFn = (
  request: QuestionRequest,
  signal: AbortSignal,
) => Promise<QuestionReply>;

interface PendingQuestion {
  settle: (reply: QuestionReply) => void;
}

export class QuestionManager {
  private readonly pending = new Map<string, PendingQuestion>();
  private askedListener: ((request: QuestionRequest) => void) | null = null;

  /** Session 订阅后转发为 question-asked 事件；单订阅者（事件流只有一个） */
  onAsked(listener: (request: QuestionRequest) => void): void {
    this.askedListener = listener;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  ask(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionReply> {
    if (this.pending.has(request.id) || signal?.aborted === true) {
      return Promise.resolve({ cancelled: true });
    }
    return new Promise((resolve) => {
      const settle = (reply: QuestionReply): void => {
        this.pending.delete(request.id);
        signal?.removeEventListener('abort', onAbort);
        resolve(reply);
      };
      const onAbort = (): void => {
        settle({ cancelled: true });
      };
      this.pending.set(request.id, { settle });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.askedListener?.(request);
    });
  }

  /** 返回 false 表示没有该 id 的挂起提问（迟到或重复的回复） */
  reply(id: string, reply: QuestionReply): boolean {
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
      entry.settle({ cancelled: true });
    }
  }
}
