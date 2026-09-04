import type { AgentEvent } from '#/core/events';
import type { ApprovalRequest } from '#/core/permission/approval';
import type { PlanApprovalRequest } from '#/core/plan-mode';
import type { QuestionRequest } from '#/core/question';
import type { TodoItem } from '#/core/todos';
import type { TokenUsage } from '#/provider/types';

import { completeLinesOnly } from './stream-utils';

/**
 * Session 事件 → UI 状态的纯聚合层（不依赖 React，直接配单测）。
 * blocks 是已完成、进 Static 区的内容；streaming 是进行中的流式输出。
 */

export interface UserBlock {
  id: number;
  kind: 'user';
  text: string;
}

export interface AssistantBlock {
  id: number;
  kind: 'assistant';
  text: string;
  reasoning: string | null;
  /** 同一段流式输出的续块（前一块也是 assistant）：渲染时不留块间距，拼回一整段 */
  continuation: boolean;
}

export interface ToolBlock {
  id: number;
  kind: 'tool';
  toolCallId: string;
  name: string;
  /** 事件到达时经 DescribeCall 算好的一句话摘要 */
  description: string;
  input: unknown;
  status: 'running' | 'done';
  output: string | null;
  isError: boolean;
  durationMs: number | null;
}

export interface ErrorBlock {
  id: number;
  kind: 'error';
  message: string;
}

/** 本地提示（中断、max-steps 等），不进消息历史 */
export interface NoticeBlock {
  id: number;
  kind: 'notice';
  text: string;
}

export type UiBlock = UserBlock | AssistantBlock | ToolBlock | ErrorBlock | NoticeBlock;

/** Omit 对 union 不分配，需要分发版本才能逐成员去掉 id */
type BlockWithoutId = UiBlock extends infer T
  ? T extends UiBlock
    ? Omit<T, 'id'>
    : never
  : never;

export interface StreamingState {
  /** turn 在飞（也是全局 busy 标志） */
  active: boolean;
  reasoning: string;
  text: string;
}

/** 待用户决断的弹窗：审批、提问或计划批准。一次只显示队首，先到的先显示 */
export type PendingDialog =
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'plan-approval'; request: PlanApprovalRequest };

export interface SessionUiState {
  blocks: UiBlock[];
  streaming: StreamingState;
  /** 审批/提问弹窗队列；回复队首后出队，露出下一个 */
  pendingDialogs: PendingDialog[];
  /** 已提交但尚未开始执行的 user-turn 数（session 内部排队） */
  queuedCount: number;
  /** 上一个 turn 的累计 token 用量，状态栏用 */
  lastUsage: TokenUsage | null;
  /** 会话级任务列表（todo 工具全量替换），状态栏上方渲染 */
  todos: TodoItem[];
  /** 运行中的后台任务数（task-started / task-finished 事件携带的运行计数） */
  runningTasks: number;
  nextId: number;
}

export type DescribeCall = (name: string, input: unknown) => string;

/** 流式缓冲的增量冲刷阈值（完整行数） */
export const STREAM_FLUSH_THRESHOLD_LINES = 20;

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function initialSessionUiState(): SessionUiState {
  return {
    blocks: [],
    streaming: { active: false, reasoning: '', text: '' },
    pendingDialogs: [],
    queuedCount: 0,
    lastUsage: null,
    todos: [],
    runningTasks: 0,
    nextId: 1,
  };
}

function pushBlock(state: SessionUiState, block: BlockWithoutId): SessionUiState {
  return {
    ...state,
    blocks: [...state.blocks, { ...block, id: state.nextId } as UiBlock],
    nextId: state.nextId + 1,
  };
}

/** 完整行数（'\n' 个数）；增量冲刷的触发条件 */
function countCompleteLines(text: string): number {
  let count = 0;
  let index = text.indexOf('\n');
  while (index !== -1) {
    count += 1;
    index = text.indexOf('\n', index + 1);
  }
  return count;
}

/** 续块判定：前一块也是 assistant → 同一段流式输出的后续部分 */
function pushAssistantBlock(
  state: SessionUiState,
  text: string,
  reasoning: string | null,
): SessionUiState {
  return pushBlock(state, {
    kind: 'assistant',
    text,
    reasoning,
    continuation: state.blocks.at(-1)?.kind === 'assistant',
  });
}

/** 流式缓冲区有内容则落成 assistant block 并清空；active 状态保持不变 */
function flushStreaming(state: SessionUiState): SessionUiState {
  const { text, reasoning } = state.streaming;
  if (text === '' && reasoning === '') {
    return state;
  }
  return {
    ...pushAssistantBlock(state, text, reasoning === '' ? null : reasoning),
    streaming: { ...state.streaming, text: '', reasoning: '' },
  };
}

/**
 * 增量冲刷：完整行达阈值即落成 assistant block 进 Static 区，动态区只保留尾部，
 * 避免长流式输出下每个节流帧对全量缓冲重跑 sanitize+折行（O(n²)）与内存累积。
 * reasoning 先于 text 的块序按阶段保持：text 冲刷会把 reasoning 余量整段带走；
 * text 段开始后才到达的 reasoning（交错流，罕见）未达阈值时留缓冲随下次 text
 * 落块，超阈值时单独落块——此时块序不再全局保持 reasoning 在前，是可接受取舍。
 */
function flushCompletedLines(state: SessionUiState): SessionUiState {
  const { text, reasoning } = state.streaming;
  if (text === '') {
    if (countCompleteLines(reasoning) < STREAM_FLUSH_THRESHOLD_LINES) {
      return state;
    }
    const { complete, rest } = completeLinesOnly(reasoning);
    return {
      ...pushAssistantBlock(state, '', complete),
      streaming: { ...state.streaming, reasoning: rest },
    };
  }
  if (countCompleteLines(text) < STREAM_FLUSH_THRESHOLD_LINES) {
    return state;
  }
  const { complete, rest } = completeLinesOnly(text);
  return {
    ...pushAssistantBlock(state, complete, reasoning === '' ? null : reasoning),
    streaming: { ...state.streaming, text: rest, reasoning: '' },
  };
}

/** 用户提交（UI 动作，非 session 事件）：上屏 user block；turn 在飞则计入排队数 */
export function reduceSubmit(state: SessionUiState, text: string): SessionUiState {
  const withBlock = pushBlock(state, { kind: 'user', text });
  return state.streaming.active ? { ...withBlock, queuedCount: state.queuedCount + 1 } : withBlock;
}

/** 节流后的流式 delta 同步：把缓冲的 text/reasoning 追加进 streaming，完整行超阈值则增量冲刷 */
export function reduceStreamSync(state: SessionUiState, text: string, reasoning: string): SessionUiState {
  if (!state.streaming.active || (text === '' && reasoning === '')) {
    return state;
  }
  return flushCompletedLines({
    ...state,
    streaming: {
      ...state.streaming,
      text: state.streaming.text + text,
      reasoning: state.streaming.reasoning + reasoning,
    },
  });
}

/** 弹窗已回复（UI 动作）：队首出队，露出队列中下一个弹窗 */
export function reduceDialogReplied(state: SessionUiState): SessionUiState {
  return state.pendingDialogs.length === 0
    ? state
    : { ...state, pendingDialogs: state.pendingDialogs.slice(1) };
}

/** 本地提示上屏（斜杠命令输出等），不进消息历史 */
export function reduceNotice(state: SessionUiState, text: string): SessionUiState {
  return pushBlock(state, { kind: 'notice', text });
}

/** /clear：清空 Static 区 */
export function reduceClearBlocks(state: SessionUiState): SessionUiState {
  return { ...state, blocks: [] };
}

export function reduceEvent(
  state: SessionUiState,
  event: AgentEvent,
  describe: DescribeCall,
): SessionUiState {
  switch (event.type) {
    case 'turn-started':
      return {
        ...flushStreaming(state),
        streaming: { active: true, reasoning: '', text: '' },
        queuedCount: Math.max(0, state.queuedCount - 1),
      };
    case 'text-delta':
      return reduceStreamSync(state, event.text, '');
    case 'reasoning-delta':
      return reduceStreamSync(state, '', event.text);
    case 'tool-call-started': {
      const flushed = flushStreaming(state);
      return pushBlock(flushed, {
        kind: 'tool',
        toolCallId: event.toolCallId,
        name: event.name,
        description: describe(event.name, event.input),
        input: event.input,
        status: 'running',
        output: null,
        isError: false,
        durationMs: null,
      });
    }
    case 'tool-call-completed': {
      // 权限拒绝/审批拒绝的调用在 preflight 阶段直接落结果，不会先发 started，
      // 没有对应 running 块时直接落完成块，否则拒绝在 TUI 里不可见
      const exists = state.blocks.some(
        (block) => block.kind === 'tool' && block.toolCallId === event.toolCallId,
      );
      if (!exists) {
        return pushBlock(state, {
          kind: 'tool',
          toolCallId: event.toolCallId,
          name: event.name,
          description: describe(event.name, event.input),
          input: event.input,
          status: 'done',
          output: event.output,
          isError: event.isError,
          durationMs: event.durationMs,
        });
      }
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.kind === 'tool' && block.toolCallId === event.toolCallId
            ? {
                ...block,
                status: 'done' as const,
                output: event.output,
                isError: event.isError,
                durationMs: event.durationMs,
              }
            : block,
        ),
      };
    }
    case 'step-finished':
      return state;
    case 'turn-complete': {
      const flushed = flushStreaming(state);
      const next: SessionUiState = {
        ...flushed,
        streaming: { active: false, reasoning: '', text: '' },
        lastUsage: event.usage,
      };
      return event.stopReason === 'max-steps'
        ? pushBlock(next, { kind: 'notice', text: `已达到最大步数（${event.steps} 步），turn 结束` })
        : next;
    }
    case 'interrupted': {
      const flushed = flushStreaming(state);
      return {
        ...pushBlock(flushed, { kind: 'notice', text: '已中断' }),
        streaming: { active: false, reasoning: '', text: '' },
        pendingDialogs: [],
      };
    }
    case 'error': {
      const flushed = flushStreaming(state);
      const withError = pushBlock(flushed, { kind: 'error', message: event.message });
      // recoverable=false 时 turn 因此结束（此路径 Session 不再发 turn-complete）
      return event.recoverable
        ? withError
        : { ...withError, streaming: { active: false, reasoning: '', text: '' } };
    }
    case 'approval-requested':
      return {
        ...state,
        pendingDialogs: [...state.pendingDialogs, { kind: 'approval', request: event.request }],
      };
    case 'question-asked':
      return {
        ...state,
        pendingDialogs: [...state.pendingDialogs, { kind: 'question', request: event.request }],
      };
    case 'plan-approval-requested':
      return {
        ...state,
        pendingDialogs: [...state.pendingDialogs, { kind: 'plan-approval', request: event.request }],
      };
    case 'plan-mode-changed':
      // 状态栏的权限模式显示由 App 订阅该事件同步；进/出计划模式的上下文
      // 已由 enter/exit 工具块展示，blocks 无需额外提示
      return state;
    case 'compacted':
      return pushBlock(state, {
        kind: 'notice',
        text:
          `已压缩上下文：${event.beforeCount} → ${event.afterCount} 条消息` +
          `（约 ${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens）`,
      });
    case 'model-fallback':
      return pushBlock(state, {
        kind: 'notice',
        text: `模型 ${event.from} 失败，已切换到 ${event.to}：${event.reason}`,
      });
    case 'todos-updated':
      return { ...state, todos: event.todos };
    case 'task-started':
      // 启动本身不上屏（bash 工具块已展示），只刷新状态栏计数
      return { ...state, runningTasks: event.runningCount };
    case 'hook-notice':
      return pushBlock(state, {
        kind: 'notice',
        text: event.isWarning ? `⚠ ${event.text}` : event.text,
      });
    case 'task-finished': {
      const command =
        event.command.length > 60 ? `${event.command.slice(0, 60)}…` : event.command;
      const text =
        event.status === 'completed'
          ? `task ${event.taskId} 已完成 (exit ${event.exitCode ?? 0}): ${command}`
          : event.status === 'failed'
            ? `task ${event.taskId} 失败 (exit ${event.exitCode ?? '信号终止'}): ${command}`
            : `task ${event.taskId} 已停止: ${command}`;
      return {
        ...pushBlock(state, { kind: 'notice', text }),
        runningTasks: event.runningCount,
      };
    }
  }
}
