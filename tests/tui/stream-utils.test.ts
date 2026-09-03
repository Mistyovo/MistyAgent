import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { completeLinesOnly, createThrottledEmitter } from '#/tui/controllers/stream-utils';

describe('completeLinesOnly', () => {
  it('无换行时 complete 为空，整段进 rest', () => {
    expect(completeLinesOnly('hello')).toEqual({ complete: '', rest: 'hello' });
  });

  it('空字符串', () => {
    expect(completeLinesOnly('')).toEqual({ complete: '', rest: '' });
  });

  it('以换行结尾时全部上屏，rest 为空', () => {
    expect(completeLinesOnly('hello\n')).toEqual({ complete: 'hello', rest: '' });
  });

  it('只保留到最后一个换行，尾部不完整行进 rest', () => {
    expect(completeLinesOnly('a\nb\nc')).toEqual({ complete: 'a\nb', rest: 'c' });
  });

  it('Windows 风格的 \\r\\n 里最后一个 \\n 之前的 \\r 保留在 complete', () => {
    expect(completeLinesOnly('a\r\nb')).toEqual({ complete: 'a\r', rest: 'b' });
  });
});

describe('createThrottledEmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次 schedule 立即 emit（leading）', () => {
    const emit = vi.fn();
    const throttled = createThrottledEmitter(emit, 50);
    throttled.schedule();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('冷却窗口内的 schedule 合并为窗口结束时的一次 trailing emit', () => {
    const emit = vi.fn();
    const throttled = createThrottledEmitter(emit, 50);
    throttled.schedule();
    throttled.schedule();
    throttled.schedule();
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('窗口过后无挂起则不 emit；下一次 schedule 重新 leading', () => {
    const emit = vi.fn();
    const throttled = createThrottledEmitter(emit, 50);
    throttled.schedule();
    vi.advanceTimersByTime(50);
    expect(emit).toHaveBeenCalledTimes(1);
    throttled.schedule();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('连续数据流：每窗口至多一次 trailing', () => {
    const emit = vi.fn();
    const throttled = createThrottledEmitter(emit, 50);
    throttled.schedule();
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(10);
      throttled.schedule();
    }
    // 100ms 内：leading 1 次 + 50ms/100ms 各一次 trailing 合并
    expect(emit.mock.calls.length).toBeLessThanOrEqual(3);
    vi.advanceTimersByTime(50);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('flush 立即冲掉挂起的合并更新；无挂起时不重复 emit', () => {
    const emit = vi.fn();
    const throttled = createThrottledEmitter(emit, 50);
    throttled.schedule();
    throttled.schedule();
    throttled.flush();
    expect(emit).toHaveBeenCalledTimes(2);
    throttled.flush();
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('cancel 丢弃挂起更新并清理定时器', () => {
    const emit = vi.fn();
    const throttled = createThrottledEmitter(emit, 50);
    throttled.schedule();
    throttled.schedule();
    throttled.cancel();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
