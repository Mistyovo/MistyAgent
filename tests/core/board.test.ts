import { describe, expect, it } from 'vitest';

import { harvestBoardEntries, TaskBoard } from '#/core/board';

describe('TaskBoard', () => {
  it('add：按 kind + 规范化文本去重（大小写/多余空白视为同一条）', () => {
    const board = new TaskBoard();
    board.add('fact', 'foo 定义在 a.ts:1', 'Agent(explore)');
    board.add('fact', '  Foo 定义在  a.ts:1 ', 'Agent(plan)');

    expect(board.entries()).toHaveLength(1);
    // 保留首次写入的原文（单行化、保留大小写）与来源
    expect(board.entries()[0]).toMatchObject({
      kind: 'fact',
      text: 'foo 定义在 a.ts:1',
      source: 'Agent(explore)',
    });
    expect(board.entries()[0]!.createdAt).toBeGreaterThan(0);
  });

  it('add：同文本不同 kind 各自保留', () => {
    const board = new TaskBoard();
    board.add('fact', '走 b.ts 方向', 'A');
    board.add('deadend', '走 b.ts 方向', 'B');

    expect(board.entries().map((entry) => entry.kind)).toEqual(['fact', 'deadend']);
  });

  it('add：空白文本忽略', () => {
    const board = new TaskBoard();
    board.add('fact', '', 'A');
    board.add('deadend', '   \n  ', 'B');

    expect(board.isEmpty()).toBe(true);
  });

  it('容量超出丢最旧；被丢条目的去重键同步释放', () => {
    const board = new TaskBoard({ maxEntries: 2 });
    board.add('fact', ' oldest ', 'A');
    board.add('fact', 'second', 'A');
    board.add('deadend', 'third', 'A');

    expect(board.entries().map((entry) => entry.text)).toEqual(['second', 'third']);
    // 最旧条目的键已释放：可重新写入而不被误判为重复
    board.add('fact', 'OLDEST', 'B');
    expect(board.entries().map((entry) => entry.text)).toEqual(['third', 'OLDEST']);
  });

  it('render：分节渲染，每节按时间序列出 "- text（来源）"', () => {
    const board = new TaskBoard();
    board.add('deadend', '改配置中心方向已排除', 'Agent(plan)');
    board.add('fact', 'foo 定义在 a.ts:1', 'Agent(explore)');
    board.add('fact', 'bar 读取配置项 x', 'Agent(explore)');

    expect(board.render()).toBe(
      [
        '已确认的事实：',
        '- foo 定义在 a.ts:1（Agent(explore)）',
        '- bar 读取配置项 x（Agent(explore)）',
        '',
        '已排除的方向（不要重复尝试）：',
        '- 改配置中心方向已排除（Agent(plan)）',
      ].join('\n'),
    );
  });

  it('render：空节显示占位', () => {
    const board = new TaskBoard();
    board.add('fact', 'f', 'A');

    expect(board.render()).toContain('已排除的方向（不要重复尝试）：\n（暂无）');
  });

  it('reset：清空条目与去重键', () => {
    const board = new TaskBoard();
    board.add('fact', 'foo', 'A');
    board.reset();

    expect(board.isEmpty()).toBe(true);
    expect(board.entries()).toEqual([]);
    board.add('fact', 'foo', 'B');
    expect(board.entries()).toHaveLength(1);
  });
});

describe('harvestBoardEntries', () => {
  it('收割 VERIFIED_FACT / DEADEND 标记行，夹杂普通行忽略', () => {
    const text = [
      '结论：已定位到实现。',
      'VERIFIED_FACT: foo 定义在 a.ts:1',
      '还有一行普通文本',
      'DEADEND: 配置中心方案不适用',
    ].join('\n');

    expect(harvestBoardEntries(text)).toEqual([
      { kind: 'fact', text: 'foo 定义在 a.ts:1' },
      { kind: 'deadend', text: '配置中心方案不适用' },
    ]);
  });

  it('行首允许空白；内容首尾空白被裁掉', () => {
    const text = '  VERIFIED_FACT:   foo 在 a.ts:1  \n\tDEADEND:\t方向 X  ';

    expect(harvestBoardEntries(text)).toEqual([
      { kind: 'fact', text: 'foo 在 a.ts:1' },
      { kind: 'deadend', text: '方向 X' },
    ]);
  });

  it('空内容行忽略；标记不在行首不收', () => {
    const text = ['VERIFIED_FACT:', 'DEADEND:   ', '前缀 VERIFIED_FACT: 不在行首'].join('\n');

    expect(harvestBoardEntries(text)).toEqual([]);
  });

  it('单条内容截断到 200 字符', () => {
    const long = 'x'.repeat(250);

    const [entry] = harvestBoardEntries(`VERIFIED_FACT: ${long}`);

    expect(entry!.text).toHaveLength(200);
  });

  it('兼容 CRLF 行尾', () => {
    expect(harvestBoardEntries('DEADEND: 方向 Y\r\n普通行')).toEqual([
      { kind: 'deadend', text: '方向 Y' },
    ]);
  });
});
