import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  HISTORY_LIMIT,
  PromptInput,
  pushHistoryEntry,
} from '#/tui/components/PromptInput';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * React 状态更新在 ink 里是 deferred 的（上一个键位的 handler 闭包要等重渲染后才刷新）。
 * type 用于"必然改变状态"的键位：等待新帧落盘即同步完成；
 * 不产生状态变化的键位（空输入按 Enter、busy 按 Esc 等）不会有新帧，用 press + 短等待。
 */
function renderInput(busy = false) {
  const onSubmit = vi.fn<(text: string) => void>();
  const view = render(
    <PromptInput busy={busy} queuedCount={0} disabled={false} onSubmit={onSubmit} />,
  );
  const type = async (data: string): Promise<void> => {
    const before = view.frames.length;
    view.stdin.write(data);
    await vi.waitFor(() => {
      expect(view.frames.length).toBeGreaterThan(before);
    });
  };
  const press = async (data: string): Promise<void> => {
    view.stdin.write(data);
    await sleep(50);
  };
  return { ...view, onSubmit, type, press };
}

describe('PromptInput 手动换行（#12）', () => {
  it('Alt+Enter（到达为 \x1b\r，ink 解析为 meta+return）插入换行，含换行输入整体提交', async () => {
    const { lastFrame, onSubmit, type } = renderInput();
    await type('ab');
    await type('\x1b\r');
    await type('cd');
    expect(lastFrame()).toContain('ab');
    expect(lastFrame()).toContain('cd');
    await type('\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith('ab\ncd');
  });

  it('Alt+Enter 在光标处插入换行（不限于行尾）', async () => {
    const { onSubmit, type } = renderInput();
    await type('ab');
    await type('\x1b[D'); // ← 光标移到 a|b 之间
    await type('\x1b\r'); // → 'a\nb'，光标落在行行首
    await type('cd'); // → 'a\ncdb'
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('a\ncdb');
  });

  it('行尾 \\ + Enter 续行兜底（终端吞掉 Alt+Enter 时），反斜杠被吃掉', async () => {
    const { onSubmit, type } = renderInput();
    await type('abc\\');
    await type('\r'); // 续行，不提交
    expect(onSubmit).not.toHaveBeenCalled();
    await type('def');
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('abc\ndef');
  });
});

describe('PromptInput 多行光标移动与编辑键位（#16）', () => {
  it('多行 ↑/↓ 行间移动保持列位置，目标行更短则落行尾', async () => {
    const { onSubmit, type } = renderInput();
    await type('abcd');
    await type('\x1b\r');
    await type('x'); // 'abcd\nx'，光标 line1 col1
    await type('\x1b[A'); // ↑ → line0 col1（列保持）
    await type('Y'); // 'aYbcd\nx'
    await type('\x1b[B'); // ↓ → line1 col min(2,1)=1（钳到行尾）
    await type('Z'); // 'aYbcd\nxZ'
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('aYbcd\nxZ');
  });

  it('光标到首行顶 ↑ 才进历史，末行底 ↓ 恢复底稿', async () => {
    const { lastFrame, onSubmit, type } = renderInput();
    await type('prev-entry');
    await type('\r'); // 入历史
    await type('l1');
    await type('\x1b\r');
    await type('l2'); // 'l1\nl2'，光标在末行
    await type('\x1b[A'); // 行间上移，不是历史
    await type('X'); // 'l1X\nl2'
    expect(lastFrame()).not.toContain('prev-entry\n');
    await type('\x1b[A'); // 已在首行 → 历史导航
    expect(lastFrame()).toContain('prev-entry');
    await type('\x1b[B'); // 历史前进到底 → 恢复底稿
    expect(lastFrame()).toContain('l1X');
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('l1X\nl2');
  });

  it('Home/End 与 Ctrl+A/E 移到行首/行尾（多行时作用于光标所在行）', async () => {
    const { onSubmit, type } = renderInput();
    await type('ab');
    await type('\x1b\r');
    await type('cde'); // 'ab\ncde'，光标 line1 col3
    await type('\x01'); // Ctrl+A → line1 col0
    await type('X'); // 'ab\nXcde'
    await type('\x1b[F'); // End → line1 行尾
    await type('Y'); // 'ab\nXcdeY'
    await type('\x1b[H'); // Home → line1 col0
    await type('Z'); // 'ab\nZXcdeY'
    await type('\x05'); // Ctrl+E → line1 行尾
    await type('W'); // 'ab\nZXcdeYW'
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('ab\nZXcdeYW');
  });

  it('Ctrl+U 清空当前输入', async () => {
    const { lastFrame, onSubmit, type, press } = renderInput();
    await type('draft text');
    await type('\x15');
    expect(lastFrame()).not.toContain('draft text');
    await press('\r'); // 空输入不提交（无状态变化，不产生新帧）
    expect(onSubmit).not.toHaveBeenCalled();
    await type('next');
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('next');
  });

  it('Ctrl+W 删除光标前的一个词（连同词前空白）', async () => {
    const { onSubmit, type } = renderInput();
    await type('hello world  ');
    await type('\x17'); // 删 'world' 与其后的尾部空白 → 'hello '
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('hello ');
  });

  it('Esc：空闲且输入非空时清空输入', async () => {
    const { lastFrame, onSubmit, type, press } = renderInput();
    await type('draft');
    await type('\x1b'); // 清空（\x1b 单独到达经 pending-escape flush 后处理）
    expect(lastFrame()).not.toContain('draft');
    await press('\r'); // 空输入不提交
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Esc：busy（turn 进行中）时不清空——中断语义由 App 负责', async () => {
    const { lastFrame, onSubmit, type, press } = renderInput(true);
    await type('draft');
    await press('\x1b'); // busy：不处理，无新帧
    expect(lastFrame()).toContain('draft');
    await type('\r'); // busy 时输入仍提交（进队列）
    expect(onSubmit).toHaveBeenLastCalledWith('draft');
  });
});

describe('PromptInput 输入历史（#16）', () => {
  it('连续重复提交只入栈一次（行为探针：到底后 ↓ 应回到相邻条）', async () => {
    const { onSubmit, type, press } = renderInput();
    await type('A');
    await type('\r');
    await type('A');
    await type('\r');
    await type('B');
    await type('\r');
    await type('\x1b[A'); // 'B'
    await type('\x1b[A'); // 'A'
    await press('\x1b[A'); // 已到底，保持 'A'（无状态变化）
    await type('\x1b[B'); // 若重复入栈会落在中间的 'A'，去重后应回到 'B'
    await type('\r');
    expect(onSubmit).toHaveBeenLastCalledWith('B');
  });

  it('pushHistoryEntry：连续重复不入栈，非连续重复保留', () => {
    const history: string[] = [];
    pushHistoryEntry(history, 'a');
    pushHistoryEntry(history, 'a');
    pushHistoryEntry(history, 'b');
    pushHistoryEntry(history, 'b');
    pushHistoryEntry(history, 'a');
    expect(history).toEqual(['a', 'b', 'a']);
  });

  it('pushHistoryEntry：超过 HISTORY_LIMIT 时最老的出栈', () => {
    const history: string[] = [];
    for (let index = 1; index <= HISTORY_LIMIT + 5; index += 1) {
      pushHistoryEntry(history, `cmd-${index}`);
    }
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]).toBe('cmd-6');
    expect(history.at(-1)).toBe(`cmd-${HISTORY_LIMIT + 5}`);
  });
});
