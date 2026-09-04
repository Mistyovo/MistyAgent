import { describe, expect, it } from 'vitest';

import {
  measureTerminalWidth,
  sanitizeTerminalText,
  truncateTerminalText,
  wrapTerminalLine,
  wrapTerminalLineWithCursor,
  wrapTerminalText,
} from '#/tui/terminal-text';

describe('sanitizeTerminalText', () => {
  it('剥离 CSI/SGR 序列', () => {
    expect(sanitizeTerminalText('a\x1b[31mb\x1b[0mc')).toBe('abc');
  });

  it('剥离 OSC（BEL 与 ESC\\ 两种终止）', () => {
    expect(sanitizeTerminalText('x\x1b]8;;https://example.com\x07link\x1b]8;;\x07y')).toBe('xlinky');
    expect(sanitizeTerminalText('x\x1b]0;title\x1b\\y')).toBe('xy');
  });

  it('剥离裸控制字符（\r \x07 \x0b \x9b），保留 \n', () => {
    expect(sanitizeTerminalText('ab\rcd\x07e\x0bf\x9bg\nh')).toBe('abcdefg\nh');
  });

  it('\\t 展开为 4 空格', () => {
    expect(sanitizeTerminalText('a\tb')).toBe('a    b');
  });

  it('孤立 ESC 与残缺序列不残留', () => {
    // ESC + 下一字符本就是终端眼里的两字符转义序列，一并剥掉与终端行为一致
    expect(sanitizeTerminalText('a\x1bb')).toBe('a');
    expect(sanitizeTerminalText('a\x1b')).toBe('a');
  });
});

describe('measureTerminalWidth', () => {
  it('narrow：歧义字符 1 格；legacy-cjk：2 格', () => {
    expect(measureTerminalWidth('……', 'narrow')).toBe(2);
    expect(measureTerminalWidth('……', 'legacy-cjk')).toBe(4);
  });

  it('CJK 宽字符两种模式都是 2 格', () => {
    expect(measureTerminalWidth('汉字', 'narrow')).toBe(4);
    expect(measureTerminalWidth('汉字', 'legacy-cjk')).toBe(4);
  });
});

describe('wrapTerminalLine', () => {
  it('按物理宽度硬折行（legacy-cjk 下歧义字符占预算 2 格）', () => {
    // 物理 10 + 40 > 预算 40：'…' 只能放 15 个（10 + 30 ≤ 40）
    const segments = wrapTerminalLine(`首标记HEAD${'…'.repeat(20)}`, 40, 'legacy-cjk');
    expect(segments[0]).toBe(`首标记HEAD${'…'.repeat(15)}`);
    expect(segments[1]).toBe('…'.repeat(5));
  });

  it('窄于预算时不折行；空行返回一段空串', () => {
    expect(wrapTerminalLine('abc', 40, 'narrow')).toEqual(['abc']);
    expect(wrapTerminalLine('', 40, 'narrow')).toEqual(['']);
  });

  it('预算为零/负数时按 1 格兜底', () => {
    expect(wrapTerminalLine('ab', 0, 'narrow')).toEqual(['a', 'b']);
  });
});

describe('wrapTerminalText', () => {
  it('先 sanitize 再折行，多行输入逐行处理', () => {
    const out = wrapTerminalText('ab\x1b[31mcd\n回回回', 4, 'legacy-cjk');
    expect(out).toBe('abcd\n回回\n回');
  });
});

describe('wrapTerminalLineWithCursor', () => {
  it('光标落在折行缝上时归入后一段', () => {
    expect(wrapTerminalLineWithCursor('abcdef', 3, 3, 'narrow')).toEqual({
      segments: ['abc', 'def'],
      cursorSegment: 1,
      cursorCol: 0,
    });
  });

  it('光标在段中间 / 行尾', () => {
    expect(wrapTerminalLineWithCursor('abcdef', 4, 3, 'narrow')).toEqual({
      segments: ['abc', 'def'],
      cursorSegment: 1,
      cursorCol: 1,
    });
    expect(wrapTerminalLineWithCursor('abc', 3, 10, 'narrow')).toEqual({
      segments: ['abc'],
      cursorSegment: 0,
      cursorCol: 3,
    });
  });

  it('legacy-cjk 下按物理宽度折行且光标按 string offset 对齐', () => {
    // 回 = 2 格：预算 6 → 每段 3 个回
    const result = wrapTerminalLineWithCursor('回回回回', 2, 6, 'legacy-cjk');
    expect(result.segments).toEqual(['回回回', '回']);
    expect(result.cursorSegment).toBe(0);
    expect(result.cursorCol).toBe(2);
  });
});

describe('truncateTerminalText', () => {
  it('未超宽原样返回（含 sanitize）', () => {
    expect(truncateTerminalText('abc\x1b[31m', 10, 'narrow')).toBe('abc');
  });

  it('超宽截断并补 …，总物理宽度 ≤ 预算（legacy-cjk 下 … 占 2 格）', () => {
    const out = truncateTerminalText('回'.repeat(10), 9, 'legacy-cjk');
    expect(out).toBe(`${'回'.repeat(3)}…`);
    expect(measureTerminalWidth(out, 'legacy-cjk')).toBeLessThanOrEqual(9);
  });

  it('预算 ≤ 1 时返回空', () => {
    expect(truncateTerminalText('abc', 1, 'narrow')).toBe('');
    expect(truncateTerminalText('abc', 0, 'narrow')).toBe('');
  });
});
