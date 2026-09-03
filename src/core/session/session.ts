import type { ChatProvider, Message } from '#/provider/types';

import { errorMessage } from '../errors';
import type { AgentEvent, EventListener, TurnStopReason } from '../events';
import { runTurn, type RunTurnResult } from '../loop/run-turn';
import type { UserTurnOp } from '../ops';
import type { Tool } from '../tools/tool';

export interface SessionConfig {
  provider: ChatProvider;
  model: string;
  systemPrompt: string;
  tools: Tool[];
  cwd: string;
  maxSteps?: number | undefined;
}

interface QueuedTurn {
  op: UserTurnOp;
  resolve: (result: RunTurnResult) => void;
}

/**
 * 会话：持有消息历史与事件订阅者，串行执行 turn。
 * turn 进行中收到的 user-turn 排队，当前 turn 结束后自动开始下一个。
 */
export class Session {
  private readonly config: SessionConfig;
  private readonly messages: Message[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly queue: QueuedTurn[] = [];
  private activeController: AbortController | null = null;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** 返回的 Promise 在该 turn 实际执行完时兑现（排队中的 turn 亦然） */
  submit(op: UserTurnOp): Promise<RunTurnResult> {
    return new Promise((resolve) => {
      this.queue.push({ op, resolve });
      this.pump();
    });
  }

  interrupt(): void {
    this.activeController?.abort();
  }

  private dispatch(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常隔离，不影响 agent loop 与其他监听器
      }
    }
  }

  private pump(): void {
    if (this.activeController !== null) {
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) {
      return;
    }
    const controller = new AbortController();
    this.activeController = controller;
    this.messages.push({ role: 'user', content: next.op.text });
    void runTurn({
      provider: this.config.provider,
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      messages: this.messages,
      tools: this.config.tools,
      cwd: this.config.cwd,
      maxSteps: this.config.maxSteps,
      signal: controller.signal,
      dispatchEvent: (event) => {
        this.dispatch(event);
      },
    })
      .catch((error: unknown): RunTurnResult => {
        this.dispatch({ type: 'error', message: errorMessage(error), recoverable: false });
        return {
          stopReason: 'error' satisfies TurnStopReason,
          steps: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      })
      .then((result) => {
        next.resolve(result);
      })
      .finally(() => {
        this.activeController = null;
        this.pump();
      });
  }
}
