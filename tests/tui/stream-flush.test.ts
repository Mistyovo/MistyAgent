import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '#/core/events';
import {
  STREAM_FLUSH_THRESHOLD_LINES,
  initialSessionUiState,
  reduceEvent,
  reduceStreamSync,
  type AssistantBlock,
  type DescribeCall,
  type SessionUiState,
} from '#/tui/controllers/session-reducer';

const describeCall: DescribeCall = (name) => `desc:${name}`;

function run(state: SessionUiState, ...events: AgentEvent[]): SessionUiState {
  return events.reduce((current, event) => reduceEvent(current, event, describeCall), state);
}

function started(): SessionUiState {
  return run(initialSessionUiState(), { type: 'turn-started' });
}

function sync(state: SessionUiState, text: string, reasoning = ''): SessionUiState {
  return reduceStreamSync(state, text, reasoning);
}

function assistantBlocks(state: SessionUiState): AssistantBlock[] {
  return state.blocks.filter((block): block is AssistantBlock => block.kind === 'assistant');
}

/** 拼接还原：增量冲刷在换行处切开，分隔的 '\n' 由 join 补回 */
function joinText(blocks: AssistantBlock[]): string {
  return blocks.map((block) => block.text).join('\n');
}

function joinReasoning(blocks: AssistantBlock[]): string {
  return blocks.map((block) => block.reasoning ?? '').join('\n');
}

function lines(prefix: string, from: number, to: number): string {
  return Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`).join('\n');
}

const usage = { inputTokens: 10, outputTokens: 5 };
const THRESHOLD = STREAM_FLUSH_THRESHOLD_LINES;

describe('流式增量冲刷（完整行达阈值落 Static 区）', () => {
  it('未达阈值：完整行留在动态区，不落 blocks；blocks 数组引用保持不变', () => {
    const state = started();
    const text = `${lines('L', 0, THRESHOLD - 1)}\n尾行`; // 19 个换行 + 不完整尾行
    const next = sync(state, text);
    expect(next.blocks).toHaveLength(0);
    expect(next.streaming.text).toBe(text);
    // 纯流式更新只换 streaming 字段，blocks 引用稳定（MessageList memo 生效的前提）
    expect(next.blocks).toBe(state.blocks);
  });

  it('达到阈值：完整行增量落 assistant block，动态区只保留不完整尾行', () => {
    const complete = lines('L', 0, THRESHOLD);
    const state = sync(started(), `${complete}\n尾行`);
    const blocks = assistantBlocks(state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: complete, reasoning: null, continuation: false });
    expect(state.streaming).toEqual({ active: true, text: '尾行', reasoning: '' });
  });

  it('阈值边界：第 20 个换行到达的同一帧触发冲刷', () => {
    let state = started();
    state = sync(state, lines('L', 0, THRESHOLD)); // 19 个换行：不冲
    expect(state.blocks).toHaveLength(0);
    state = sync(state, '\n'); // 第 20 个换行：冲
    expect(state.blocks).toHaveLength(1);
    expect(state.streaming.text).toBe('');
  });

  it('reasoning 余量随首个 text 冲刷块整段落块，保持 reasoning 先于 text 的块序', () => {
    const complete = lines('L', 0, THRESHOLD);
    let state = started();
    state = sync(state, '', '思考中（未换行）');
    state = sync(state, `${complete}\n尾行`);
    const blocks = assistantBlocks(state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: complete, reasoning: '思考中（未换行）' });
    expect(state.streaming.reasoning).toBe('');
  });

  it('多次增量冲刷 + turn-complete 收尾：拼接还原全文，续块打 continuation 标记', () => {
    // 45 行按 7 行一批进缓冲：第 3/6 批各触发一次增量冲刷（21 行/块）
    let state = started();
    for (let from = 0; from < 42; from += 7) {
      state = sync(state, `${lines('L', from, from + 7)}\n`);
    }
    expect(assistantBlocks(state)).toHaveLength(2);
    state = sync(state, `${lines('L', 42, 45)}\n末尾`);
    state = run(state, { type: 'turn-complete', stopReason: 'completed', steps: 1, usage });

    const blocks = assistantBlocks(state);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.continuation)).toEqual([false, true, true]);
    expect(joinText(blocks)).toBe(`${lines('L', 0, 45)}\n末尾`);
    expect(state.streaming).toEqual({ active: false, text: '', reasoning: '' });
    expect(state.lastUsage).toEqual(usage);
  });

  it('纯 reasoning 长流（text 未开始）：reasoning 完整行单独增量落块', () => {
    let state = started();
    for (let from = 0; from < 42; from += 7) {
      state = sync(state, '', `${lines('R', from, from + 7)}\n`);
    }
    expect(assistantBlocks(state)).toHaveLength(2);
    state = sync(state, '', `${lines('R', 42, 45)}\nR尾`);
    state = run(state, { type: 'turn-complete', stopReason: 'completed', steps: 1, usage });

    const blocks = assistantBlocks(state);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.text)).toEqual(['', '', '']);
    expect(blocks.map((block) => block.continuation)).toEqual([false, true, true]);
    expect(joinReasoning(blocks)).toBe(`${lines('R', 0, 45)}\nR尾`);
    expect(state.streaming).toEqual({ active: false, text: '', reasoning: '' });
  });

  it('reasoning 段先行冲刷后 text 段再冲：块序保持 reasoning 全部先于 text', () => {
    let state = started();
    state = sync(state, '', `${lines('R', 0, 25)}\n`);
    state = sync(state, `${lines('T', 0, 25)}\n尾`);
    state = run(state, { type: 'turn-complete', stopReason: 'completed', steps: 1, usage });

    const blocks = assistantBlocks(state);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ text: '', reasoning: lines('R', 0, 25), continuation: false });
    expect(blocks[1]).toMatchObject({
      text: lines('T', 0, 25),
      reasoning: null,
      continuation: true,
    });
    expect(blocks[2]).toMatchObject({ text: '尾', reasoning: null, continuation: true });
  });

  it('增量冲刷与一次性大 delta 等价：同一段输出的 blocks 拼接结果一致', () => {
    const full = `${lines('L', 0, 45)}\n末尾`;
    // 增量：7 行一批
    let incremental = started();
    for (let from = 0; from < 42; from += 7) {
      incremental = sync(incremental, `${lines('L', from, from + 7)}\n`);
    }
    incremental = sync(incremental, `${lines('L', 42, 45)}\n末尾`);
    incremental = run(incremental, { type: 'turn-complete', stopReason: 'completed', steps: 1, usage });
    // 一次性：整段一个 delta（同样超阈值，整段完整行一次冲掉）
    const oneShot = run(started(), { type: 'text-delta', text: full }, {
      type: 'turn-complete',
      stopReason: 'completed',
      steps: 1,
      usage,
    });

    const incrementalBlocks = assistantBlocks(incremental);
    const oneShotBlocks = assistantBlocks(oneShot);
    expect(joinText(incrementalBlocks)).toBe(full);
    expect(joinText(oneShotBlocks)).toBe(full);
    // 两种节奏的首块都不是续块，后续块都是续块
    expect(incrementalBlocks.map((block) => block.continuation)).toEqual([false, true, true]);
    expect(oneShotBlocks.map((block) => block.continuation)).toEqual([false, true]);
  });

  it('text 已开始后晚到的 reasoning 未达阈值：留缓冲，随下一次 text 冲刷整段落块', () => {
    let state = started();
    state = sync(state, `${lines('T', 0, 25)}\n`);
    expect(assistantBlocks(state)).toHaveLength(1);
    state = sync(state, '', 'R尾（未换行）');
    expect(assistantBlocks(state)).toHaveLength(1);
    state = sync(state, `${lines('T', 25, 45)}\n`);
    const blocks = assistantBlocks(state);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ reasoning: 'R尾（未换行）', continuation: true });
    expect(joinText(blocks)).toBe(lines('T', 0, 45));
  });

  it('text 已开始后晚到的 reasoning 超阈值：单独落块（防内存累积），位于 text 块之后', () => {
    let state = started();
    state = sync(state, `${lines('T', 0, 25)}\n`);
    state = sync(state, '', `${lines('R', 0, 30)}\n`);
    const blocks = assistantBlocks(state);
    // 交错流的罕见情形：reasoning 块落在 text 块之后，块序不再全局保持 reasoning 在前
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      text: '',
      reasoning: lines('R', 0, 30),
      continuation: true,
    });
  });
});
