import type { AgentEvent } from '#/core/events';
import type { ApprovalRequest } from '#/core/permission/approval';
import type { TokenUsage } from '#/provider/types';

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

export interface SessionUiState {
  blocks: UiBlock[];
  streaming: StreamingState;
  pendingApproval: ApprovalRequest | null;
  /** 已提交但尚未开始执行的 user-turn 数（session 内部排队） */
  queuedCount: number;
  /** 上一个 turn 的累计 token 用量，状态栏用 */
  lastUsage: TokenUsage | null;
  nextId: number;
}

export type DescribeCall = (name: string, input: unknown) => string;

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function initialSessionUiState(): SessionUiState {
  return {
    blocks: [],
    streaming: { active: false, reasoning: '', text: '' },
    pendingApproval: null,
    queuedCount: 0,
    lastUsage: null,
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

/** 流式缓冲区有内容则落成 assistant block 并清空；active 状态保持不变 */
function flushStreaming(state: SessionUiState): SessionUiState {
  const { text, reasoning } = state.streaming;
  if (text === '' && reasoning === '') {
    return state;
  }
  return {
    ...pushBlock(state, { kind: 'assistant', text, reasoning: reasoning === '' ? null : reasoning }),
    streaming: { ...state.streaming, text: '', reasoning: '' },
  };
}

/** 用户提交（UI 动作，非 session 事件）：上屏 user block；turn 在飞则计入排队数 */
export function reduceSubmit(state: SessionUiState, text: string): SessionUiState {
  const withBlock = pushBlock(state, { kind: 'user', text });
  return state.streaming.active ? { ...withBlock, queuedCount: state.queuedCount + 1 } : withBlock;
}

/** 节流后的流式 delta 同步：把缓冲的 text/reasoning 追加进 streaming */
export function reduceStreamSync(state: SessionUiState, text: string, reasoning: string): SessionUiState {
  if (!state.streaming.active || (text === '' && reasoning === '')) {
    return state;
  }
  return {
    ...state,
    streaming: {
      ...state.streaming,
      text: state.streaming.text + text,
      reasoning: state.streaming.reasoning + reasoning,
    },
  };
}

/** 审批弹窗已回复（UI 动作）：清掉挂起请求 */
export function reduceApprovalReplied(state: SessionUiState): SessionUiState {
  return state.pendingApproval === null ? state : { ...state, pendingApproval: null };
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
        pendingApproval: null,
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
      return { ...state, pendingApproval: event.request };
    case 'compacted':
      return pushBlock(state, {
        kind: 'notice',
        text:
          `已压缩上下文：${event.beforeCount} → ${event.afterCount} 条消息` +
          `（约 ${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens）`,
      });
  }
}
