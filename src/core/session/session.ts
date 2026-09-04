import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { HooksSettings, PermissionMode, PermissionRule } from '#/config/schema';
import type { ChatProvider, Message } from '#/provider/types';

import {
  compactHistory,
  DEFAULT_MAX_CONTEXT_TOKENS,
  maybeCompactHistory,
  type CompactResult,
} from '../context/compact';
import { errorMessage } from '../errors';
import type { AgentEvent, EventListener, TurnStopReason } from '../events';
import { HookRunner } from '../hooks';
import { runTurn, type RunTurnResult } from '../loop/run-turn';
import type { ApprovalReplyOp, PlanApprovalReplyOp, QuestionReplyOp, UserTurnOp } from '../ops';
import { ApprovalManager } from '../permission/approval';
import type { PermissionContext, PermissionRuntime } from '../permission/pipeline';
import {
  PlanApprovalManager,
  buildPlanModePrompt,
  type PlanApprovalReply,
  type PlanApprovalRequest,
} from '../plan-mode';
import { QuestionManager, type QuestionReply, type QuestionRequest } from '../question';
import type { TaskManager } from '../tasks';
import type { TodoStore } from '../todos';
import type { Tool } from '../tools/tool';

import { MISTY_VERSION, transcriptDirFor, TranscriptWriter, type SessionMeta } from './transcript';

export interface SessionConfig {
  provider: ChatProvider;
  model: string;
  systemPrompt: string;
  tools: Tool[];
  cwd: string;
  maxSteps?: number | undefined;
  /** 缺省 mode 为 'default'（写/执行需审批） */
  permission?: {
    mode?: PermissionMode;
    rules?: PermissionRule[];
  };
  /**
   * 会话持久化：写 <dir>/<sessionId>.jsonl（dir 缺省 ~/.misty/projects/<sanitized-cwd>）。
   * resume 时传入原 sessionId 续写同一文件（uuid 链自动续上）。缺省不持久化。
   */
  transcript?: {
    dir?: string | undefined;
    sessionId?: string | undefined;
  };
  /** resume 重建的历史 */
  initialMessages?: Message[] | undefined;
  /** 自动压缩阈值基数，缺省 DEFAULT_MAX_CONTEXT_TOKENS */
  maxContextTokens?: number | undefined;
  /** 会话级 todo 存储（todo 工具全量替换它）；变更被转发为 todos-updated 事件 */
  todos?: TodoStore | undefined;
  /**
   * 后台任务管理器（bash run_in_background 与 task_* 工具共享同一个实例）；
   * 任务启动/落定被转发为 task-started / task-finished 事件
   */
  tasks?: TaskManager | undefined;
  /** 用户配置的 shell 钩子（settings.json hooks 字段）；缺省不跑 hook */
  hooks?: HooksSettings | undefined;
}

interface QueuedTurn {
  op: UserTurnOp;
  resolve: (result: RunTurnResult) => void;
}

interface TranscriptState {
  dir: string;
  sessionId: string;
  writer: TranscriptWriter;
}

/**
 * 会话：持有消息历史、权限状态与事件订阅者，串行执行 turn。
 * turn 进行中收到的 user-turn 排队，当前 turn 结束后自动开始下一个。
 * 启用 transcript 时：user 消息先落盘再进 loop；loop 内产生的消息经
 * onMessageAppended 回调同步落盘（落盘失败降级为不持久化，不阻断会话）。
 */
export class Session {
  private readonly config: SessionConfig;
  private readonly messages: Message[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly queue: QueuedTurn[] = [];
  private readonly approvals: ApprovalManager;
  private readonly questions = new QuestionManager();
  private readonly planApprovals = new PlanApprovalManager();
  private readonly permission: PermissionRuntime;
  private permissionMode: PermissionMode;
  private readonly permissionRules: readonly PermissionRule[];
  /**
   * 计划模式状态：planMode=true 时权限模式恒为 plan（不变式），
   * previousMode 记录进入前的模式供退出时恢复（--mode plan 启动时记 default）
   */
  private planMode: boolean;
  private previousMode: PermissionMode;
  private activeController: AbortController | null = null;
  private model: string;
  private readonly maxContextTokens: number;
  private transcript: TranscriptState | null = null;
  private readonly todos: TodoStore | null = null;
  private readonly hookRunner: HookRunner | null = null;

  constructor(config: SessionConfig) {
    this.config = config;
    this.permissionMode = config.permission?.mode ?? 'default';
    this.permissionRules = config.permission?.rules ?? [];
    // 启动即 plan 模式（--mode plan / 配置）：等价于完整计划模式，来路记为 default
    this.planMode = this.permissionMode === 'plan';
    this.previousMode = 'default';
    this.model = config.model;
    this.maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    if (config.initialMessages !== undefined) {
      this.messages.push(...config.initialMessages);
    }
    if (config.todos !== undefined) {
      this.todos = config.todos;
      this.todos.onChange((todos) => {
        this.dispatch({ type: 'todos-updated', todos });
      });
    }
    if (config.tasks !== undefined) {
      config.tasks.onStarted((task, runningCount) => {
        this.dispatch({
          type: 'task-started',
          taskId: task.id,
          command: task.command,
          pid: task.pid,
          runningCount,
        });
      });
      config.tasks.onFinished((task, outputTail, runningCount) => {
        this.dispatch({
          type: 'task-finished',
          taskId: task.id,
          command: task.command,
          status: task.status as 'completed' | 'failed' | 'killed',
          exitCode: task.exitCode ?? null,
          outputTail,
          runningCount,
        });
      });
    }
    this.approvals = new ApprovalManager(config.cwd);
    if (config.hooks !== undefined) {
      this.hookRunner = new HookRunner(config.hooks);
    }
    this.questions.onAsked((request) => {
      this.dispatch({ type: 'question-asked', request });
    });
    this.planApprovals.onRequested((request) => {
      this.dispatch({ type: 'plan-approval-requested', request });
    });
    this.permission = {
      getContext: () => ({
        mode: this.permissionMode,
        rules: this.permissionRules,
        sessionApprovals: this.approvals.getSessionApprovals(),
        cwd: this.config.cwd,
      }),
      approvals: this.approvals,
    };
    if (config.transcript !== undefined) {
      try {
        this.transcript = this.createTranscript(config.transcript.sessionId ?? randomUUID());
        this.writeMeta();
      } catch {
        // transcript 目录不可写等场景：降级为不持久化
        this.transcript = null;
      }
    }
  }

  private createTranscript(sessionId: string): TranscriptState {
    const dir = this.config.transcript?.dir ?? transcriptDirFor(this.config.cwd);
    return { dir, sessionId, writer: new TranscriptWriter(join(dir, `${sessionId}.jsonl`)) };
  }

  private writeMeta(): void {
    if (this.transcript === null) {
      return;
    }
    const meta: SessionMeta = {
      sessionId: this.transcript.sessionId,
      cwd: this.config.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
      version: MISTY_VERSION,
    };
    this.transcript.writer.append('meta', meta);
  }

  private persist(message: Message): void {
    try {
      this.transcript?.writer.appendMessage(message);
    } catch {
      // 落盘失败不阻断会话
    }
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

  getModel(): string {
    return this.model;
  }

  /** 运行时切换模型（/model），对后续 step 立即生效，不写配置文件 */
  setModel(model: string): void {
    this.model = model;
  }

  getSessionId(): string | null {
    return this.transcript?.sessionId ?? null;
  }

  isActive(): boolean {
    return this.activeController !== null;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /** 当前权限上下文快照（模式/规则/会话级审批累积）；agent 子代理沿用同一判定来源 */
  getPermissionContext(): PermissionContext {
    return this.permission.getContext();
  }

  /**
   * 运行时切换权限模式（TUI shift+tab / /mode），对后续判定立即生效。
   * 切到 plan 等价于进入完整计划模式（含 prompt 指引）；计划模式中切走
   * 等价于退出——以用户显式选择为准，不恢复 previousMode。
   */
  setPermissionMode(mode: PermissionMode): void {
    if (mode === 'plan') {
      this.enterPlanMode();
      return;
    }
    if (this.planMode) {
      this.exitPlanMode(mode);
      return;
    }
    this.permissionMode = mode;
  }

  isPlanMode(): boolean {
    return this.planMode;
  }

  /** 进入计划模式：权限切到 plan 并记住来路；已激活时幂等返回 false */
  enterPlanMode(): boolean {
    if (this.planMode) {
      return false;
    }
    this.previousMode = this.permissionMode;
    this.planMode = true;
    this.permissionMode = 'plan';
    this.dispatch({
      type: 'plan-mode-changed',
      active: true,
      mode: 'plan',
      previousMode: this.previousMode,
    });
    return true;
  }

  /** 退出计划模式：target 缺省切回进入前的模式（exit_plan_mode 批准路径） */
  exitPlanMode(target?: PermissionMode): boolean {
    if (!this.planMode) {
      return false;
    }
    this.planMode = false;
    this.permissionMode = target ?? this.previousMode;
    this.dispatch({
      type: 'plan-mode-changed',
      active: false,
      mode: this.permissionMode,
      previousMode: this.previousMode,
    });
    return true;
  }

  /** /clear：清历史并开始新会话（启用持久化时开新 transcript 文件） */
  newSession(): void {
    this.messages.length = 0;
    this.todos?.clear();
    if (this.transcript !== null) {
      try {
        this.transcript = this.createTranscript(randomUUID());
        this.writeMeta();
      } catch {
        this.transcript = null;
      }
    }
  }

  /** /compact：手动压缩历史；返回 false 表示历史太短或压缩失败 */
  async compactNow(): Promise<boolean> {
    const result = await compactHistory({
      provider: this.config.provider,
      model: this.model,
      messages: this.messages,
      cwd: this.config.cwd,
      signal: this.activeController?.signal,
    });
    if (result === null) {
      return false;
    }
    this.afterCompaction(result);
    return true;
  }

  /** user-turn：返回的 Promise 在该 turn 实际执行完时兑现（排队中的 turn 亦然） */
  submit(op: UserTurnOp): Promise<RunTurnResult>;
  /** approval-reply：转发给 ApprovalManager；返回 false 表示没有该 id 的挂起审批 */
  submit(op: ApprovalReplyOp): boolean;
  /** question-reply：转发给 QuestionManager；返回 false 表示没有该 id 的挂起提问 */
  submit(op: QuestionReplyOp): boolean;
  /** plan-approval-reply：转发给 PlanApprovalManager；返回 false 表示没有该 id 的挂起审批 */
  submit(op: PlanApprovalReplyOp): boolean;
  submit(
    op: UserTurnOp | ApprovalReplyOp | QuestionReplyOp | PlanApprovalReplyOp,
  ): Promise<RunTurnResult> | boolean {
    if (op.type === 'approval-reply') {
      return this.approvals.reply(op.id, op.reply);
    }
    if (op.type === 'question-reply') {
      return this.questions.reply(op.id, op.reply);
    }
    if (op.type === 'plan-approval-reply') {
      return this.planApprovals.reply(op.id, op.reply);
    }
    return new Promise((resolve) => {
      this.queue.push({ op, resolve });
      this.pump();
    });
  }

  /** ask_user 工具的宿主入口：挂起等 question-reply Op；interrupt / signal abort 落定 cancelled */
  askUser(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionReply> {
    return this.questions.ask(request, signal);
  }

  /** exit_plan_mode 工具的宿主入口：挂起等 plan-approval-reply Op；interrupt / signal abort 落定拒绝 */
  requestPlanApproval(request: PlanApprovalRequest, signal?: AbortSignal): Promise<PlanApprovalReply> {
    return this.planApprovals.request(request, signal);
  }

  interrupt(): void {
    this.activeController?.abort();
    this.approvals.rejectAll('interrupted by user');
    this.questions.cancelAll();
    this.planApprovals.cancelAll();
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

  private async maybeCompact(): Promise<void> {
    const result = await maybeCompactHistory({
      provider: this.config.provider,
      model: this.model,
      messages: this.messages,
      maxContextTokens: this.maxContextTokens,
      cwd: this.config.cwd,
      signal: this.activeController?.signal,
    });
    if (result !== null) {
      this.afterCompaction(result);
    }
  }

  /** context-overflow 后的响应式压缩：无视阈值强制压缩；false 表示压缩未生效（不再重试） */
  private async forceCompact(): Promise<boolean> {
    const result = await maybeCompactHistory({
      provider: this.config.provider,
      model: this.model,
      messages: this.messages,
      maxContextTokens: this.maxContextTokens,
      force: true,
      cwd: this.config.cwd,
      signal: this.activeController?.signal,
    });
    if (result === null) {
      return false;
    }
    this.afterCompaction(result);
    return true;
  }

  private afterCompaction(result: CompactResult): void {
    // 压缩后 messages[0] 是摘要消息，落盘保持 transcript 与内存历史一致
    const summary = this.messages[0];
    if (summary !== undefined) {
      this.persist(summary);
    }
    this.dispatch({ type: 'compacted', ...result });
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
    const userMessage: Message = { role: 'user', content: next.op.text };
    this.messages.push(userMessage);
    this.persist(userMessage);
    void runTurn({
      provider: this.config.provider,
      model: this.model,
      getModel: () => this.model,
      systemPrompt: this.config.systemPrompt,
      // 计划模式可在一个 turn 内被工具切换：每步现读，激活时追加 plan 指引段
      getSystemPrompt: () =>
        this.planMode
          ? `${this.config.systemPrompt}\n\n${buildPlanModePrompt()}`
          : this.config.systemPrompt,
      messages: this.messages,
      onMessageAppended: (message) => {
        this.persist(message);
      },
      maybeCompact: () => this.maybeCompact(),
      forceCompact: () => this.forceCompact(),
      tools: this.config.tools,
      cwd: this.config.cwd,
      maxSteps: this.config.maxSteps,
      signal: controller.signal,
      dispatchEvent: (event) => {
        this.dispatch(event);
      },
      permission: this.permission,
      hooks: this.hookRunner ?? undefined,
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
