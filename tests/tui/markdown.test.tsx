import chalk, { type ColorSupportLevel } from 'chalk';
import { renderToString } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { ApprovalDialog } from '#/tui/components/ApprovalDialog';
import { Markdown } from '#/tui/components/Markdown';
import { MessageList } from '#/tui/components/MessageList';
import type { UiBlock } from '#/tui/controllers/session-reducer';
import { renderMarkdown } from '#/tui/markdown/render-markdown';
import { styledLinePlainText, styledLineWidth, type StyledLine } from '#/tui/markdown/styled';
import { setTerminalWidthModeForTests, type TerminalWidthMode } from '#/tui/terminal-text';
import { setThemeForTests, themePalettes, type Theme } from '#/tui/theme';

const rich = themePalettes.dark.rich;
const basic = themePalettes.dark.basic;

function render(
  markdown: string,
  overrides?: { maxWidth?: number; mode?: TerminalWidthMode; theme?: Theme },
): StyledLine[] {
  return renderMarkdown(markdown, {
    maxWidth: overrides?.maxWidth ?? 60,
    mode: overrides?.mode ?? 'narrow',
    theme: overrides?.theme ?? rich,
  });
}

function plain(lines: StyledLine[]): string[] {
  return lines.map((line) => styledLinePlainText(line));
}

/** 收集一行里满足条件的段 */
function segmentsWhere(
  lines: StyledLine[],
  predicate: (segment: StyledLine[number]) => boolean,
): StyledLine[number][] {
  return lines.flat().filter(predicate);
}

/** 以指定 chalk 色彩等级执行 run（vitest 无 TTY，默认 level 0 不发 SGR），结束后还原 */
function withChalkLevel(level: ColorSupportLevel, run: () => void): void {
  const previous = chalk.level;
  chalk.level = level;
  try {
    run();
  } finally {
    chalk.level = previous;
  }
}

function hexToSgr(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function hexToBgSgr(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

afterEach(() => {
  setThemeForTests(null);
  setTerminalWidthModeForTests(null);
});

describe('renderMarkdown 块级结构', () => {
  it('heading：# 前缀 + heading 色 + bold', () => {
    const lines = render('## 标题');
    expect(plain(lines)).toEqual(['## 标题']);
    const [first] = lines[0]!;
    expect(first).toMatchObject({ text: '## ', color: rich.markdown.heading, bold: true });
    expect(lines[0]![1]).toMatchObject({ text: '标题', color: rich.markdown.heading, bold: true });
  });

  it('段落软换行拆成两行；块间恰好一个空行，无首/尾空行、无连空', () => {
    const lines = render('# 标题\n\n第一段\n第二段\n\n\n第三段\n');
    expect(plain(lines)).toEqual(['# 标题', '', '第一段', '第二段', '', '第三段']);
  });

  it('bold / italic / 行内 code 着色，标记符号不上屏', () => {
    const lines = render('普通 **粗体** *斜体* `x = 1` ~~删除~~');
    expect(styledLinePlainText(lines[0]!)).toBe('普通 粗体 斜体 x = 1 删除');
    expect(segmentsWhere(lines, (s) => s.text === '粗体')[0]).toMatchObject({
      color: rich.markdown.bold,
      bold: true,
    });
    expect(segmentsWhere(lines, (s) => s.text === '斜体')[0]).toMatchObject({ italic: true });
    expect(segmentsWhere(lines, (s) => s.text === 'x = 1')[0]).toMatchObject({
      color: rich.markdown.codeInline,
    });
    expect(segmentsWhere(lines, (s) => s.text === '删除')[0]).toMatchObject({
      strikethrough: true,
    });
  });

  it('链接：文本 link 色 + 下划线，URL 括注 dim；label 即 URL 时不重复括注', () => {
    const lines = render('[文档](https://example.com) 与 [https://x.com](https://x.com)');
    const text = styledLinePlainText(lines[0]!);
    expect(text).toBe('文档 (https://example.com) 与 https://x.com');
    expect(segmentsWhere(lines, (s) => s.text === '文档')[0]).toMatchObject({
      color: rich.markdown.link,
      underline: true,
    });
    expect(segmentsWhere(lines, (s) => s.text === ' (https://example.com)')[0]).toMatchObject({
      dim: true,
    });
  });

  it('hr：ASCII 虚线，宽度 = maxWidth - 3（列数 - 4）', () => {
    const lines = render('上文\n\n---\n\n下文', { maxWidth: 40 });
    expect(plain(lines)).toEqual(['上文', '', '-'.repeat(37), '', '下文']);
    expect(lines[2]![0]).toMatchObject({ dim: true });
  });

  it('表格降级为逐行文本（表头加粗）', () => {
    const lines = render('| 名 | 值 |\n|---|---|\n| a | 1 |');
    expect(plain(lines)).toEqual(['名 | 值', 'a | 1']);
    expect(lines[0]![0]).toMatchObject({ bold: true });
  });
});

describe('代码块与语法高亮', () => {
  it('ts 代码块：keyword 映射 heading 色，全块描 codeBlockBg 背景并补齐到统一块宽', () => {
    const lines = render('```ts\nconst x = 1\nlet longerLine = 2\n```');
    expect(lines).toHaveLength(2);
    const keyword = segmentsWhere(lines, (s) => s.text === 'const')[0];
    expect(keyword).toMatchObject({
      color: rich.markdown.heading,
      backgroundColor: rich.markdown.codeBlockBg,
    });
    for (const line of lines) {
      expect(line.every((s) => s.backgroundColor === rich.markdown.codeBlockBg)).toBe(true);
      // 块宽 = 最长行 + 左右各 1 格
      expect(styledLineWidth(line, 'narrow')).toBe(styledLineWidth(lines[0]!, 'narrow'));
    }
    expect(plain(lines)).toEqual([' const x = 1        ', ' let longerLine = 2 ']);
  });

  it('未知语言 / 无语言围栏：按 codeBlock 纯色降级，仍有背景', () => {
    for (const fence of ['```foobarlang\nplain code\n```', '```\nplain code\n```']) {
      const lines = render(fence);
      expect(styledLinePlainText(lines[0]!)).toContain('plain code');
      expect(
        segmentsWhere(lines, (s) => s.text.includes('plain'))[0],
      ).toMatchObject({ color: rich.markdown.codeBlock });
      expect(lines[0]!.every((s) => s.backgroundColor === rich.markdown.codeBlockBg)).toBe(true);
    }
  });

  it('未闭合围栏不崩，按代码块渲染', () => {
    const lines = render('```ts\nconst x = 1');
    expect(segmentsWhere(lines, (s) => s.text === 'const')[0]).toMatchObject({
      color: rich.markdown.heading,
      backgroundColor: rich.markdown.codeBlockBg,
    });
  });

  it('超长代码行按 预算-2 折行，折行后仍全宽描背景', () => {
    const long = `const s = '${'值'.repeat(30)}'`;
    const lines = render(`\`\`\`ts\n${long}\n\`\`\``, { maxWidth: 30 });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(styledLineWidth(line, 'narrow')).toBeLessThanOrEqual(30);
      expect(line.every((s) => s.backgroundColor === rich.markdown.codeBlockBg)).toBe(true);
    }
  });
});

describe('列表与引用', () => {
  it('无序列表：listBullet 色符号 + 缩进；有序列表带起始编号；task list 用 [x]/[ ]', () => {
    const lines = render('- 甲\n- 乙\n\n3. 三\n4. 四\n\n- [x] 已完成\n- [ ] 待办');
    expect(plain(lines)).toEqual([
      '  • 甲',
      '  • 乙',
      '',
      '  3. 三',
      '  4. 四',
      '',
      '  [x] 已完成',
      '  [ ] 待办',
    ]);
    expect(segmentsWhere(lines, (s) => s.text === '• ')[0]).toMatchObject({
      color: rich.markdown.listBullet,
    });
    expect(segmentsWhere(lines, (s) => s.text === '3. ')[0]).toMatchObject({
      color: rich.markdown.listBullet,
    });
  });

  it('嵌套列表逐级右移；长项折行后对齐到文本列', () => {
    const lines = render(`- 外层\n  - 内层\n- ${'长'.repeat(20)}`, { maxWidth: 20 });
    expect(plain(lines).slice(0, 2)).toEqual(['  • 外层', '    • 内层']);
    const wrapped = plain(lines).slice(2);
    expect(wrapped.length).toBeGreaterThan(2);
    expect(wrapped[0]).toMatch(/^ {2}• /);
    for (const line of wrapped.slice(1)) {
      expect(line.startsWith('    ')).toBe(true);
    }
  });

  it('引用：▌ 前缀 quote 色，正文默认 quote 色，自带样式的段保持原色', () => {
    const lines = render('> 引用 **加粗** `码`');
    const [bar] = lines[0]!;
    expect(bar).toMatchObject({ text: '▌ ', color: rich.markdown.quote });
    expect(segmentsWhere(lines, (s) => s.text === '引用 ')[0]).toMatchObject({
      color: rich.markdown.quote,
    });
    expect(segmentsWhere(lines, (s) => s.text === '加粗')[0]).toMatchObject({
      bold: true,
      color: rich.markdown.bold,
    });
    expect(segmentsWhere(lines, (s) => s.text === '码')[0]).toMatchObject({
      color: rich.markdown.codeInline,
    });
  });

  it('多段引用：块间距行也带引用条', () => {
    const lines = render('> 一段\n>\n> 二段');
    expect(plain(lines)).toEqual(['▌ 一段', '▌ ', '▌ 二段']);
  });
});

describe('上屏不变量（terminal-text 同源语义）', () => {
  const samples = [
    `# 标题\n\n含 **粗体** 与 \`行内代码\` 与 [链接](https://example.com/very/long/path) 的段落`,
    `\`\`\`ts\nconst s = '${'长'.repeat(50)}'\n\`\`\``,
    `首标记${'…'.repeat(30)}${'——'.repeat(6)}${'汉'.repeat(20)}`,
    `> ${'引'.repeat(40)}\n\n- ${'项'.repeat(30)}`,
    Array.from({ length: 12 }, (_, i) => `${'  '.repeat(i)}- 第${i}层`).join('\n'),
    '| 列A | 列B |\n|---|---|\n| 长长长长长长长长 | 2 |',
  ];
  // oxlint-disable-next-line no-control-regex -- 本测试的职责就是断言段文本不含控制字符
  const CONTROL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/;

  for (const mode of ['narrow', 'legacy-cjk'] as const) {
    it(`${mode} 模式：所有输出行物理宽 ≤ maxWidth，段文本无控制字符/ANSI`, () => {
      for (const sample of samples) {
        const lines = render(sample, { maxWidth: 40, mode });
        for (const line of lines) {
          expect(styledLineWidth(line, mode)).toBeLessThanOrEqual(40);
          for (const segment of line) {
            expect(segment.text).not.toMatch(CONTROL);
          }
        }
      }
    });
  }
});

describe('Markdown 组件 ANSI 输出', () => {
  it('rich 主题：bold/codeInline/heading 发真彩 SGR，代码块发真彩背景，链接下划线', () => {
    setThemeForTests(rich);
    setTerminalWidthModeForTests('narrow');
    withChalkLevel(3, () => {
      const output = renderToString(
        <Markdown text={'**加粗** 与 `x`\n\n# 标题\n\n```ts\nconst x = 1\n```\n\n[链](https://x.com)'} />,
      );
      expect(output).toContain(hexToSgr(rich.markdown.bold));
      expect(output).toContain(hexToSgr(rich.markdown.codeInline));
      expect(output).toContain(hexToSgr(rich.markdown.heading));
      expect(output).toContain(hexToBgSgr(rich.markdown.codeBlockBg));
      expect(output).toContain('\x1b[4m');
      expect(output).toContain('加粗');
      expect(output).not.toContain('**');
    });
  });

  it('basic 主题：全元素渲染无真彩序列，命名色照常', () => {
    setThemeForTests(basic);
    setTerminalWidthModeForTests('narrow');
    withChalkLevel(1, () => {
      const output = renderToString(
        <Markdown
          text={'# 标题\n\n**粗** `码` [链](https://x.com)\n\n```ts\nconst x = 1\n```\n\n- 项\n\n> 引\n\n---'}
        />,
      );
      expect(output).not.toContain('38;2;');
      expect(output).not.toContain('48;2;');
      expect(output).toContain('\x1b[34m'); // heading = blue
      expect(output).toContain('\x1b[40m'); // codeBlockBg = black
      expect(output).toContain('标题');
    });
  });
});

describe('MessageList：用户消息色条 + assistant markdown', () => {
  const userBlock: UiBlock = { id: 1, kind: 'user', text: '你好' };

  it('narrow 模式：▍ 色条前缀（userMarker 色）+ userText 正文', () => {
    setThemeForTests(rich);
    setTerminalWidthModeForTests('narrow');
    withChalkLevel(3, () => {
      const output = renderToString(<MessageList blocks={[userBlock]} />);
      expect(output).toContain('▍ 你好');
      expect(output).toContain(hexToSgr(rich.userMarker));
      expect(output).toContain(hexToSgr(rich.userText));
    });
  });

  it('legacy-cjk 模式：回退 > 前缀', () => {
    setThemeForTests(basic);
    setTerminalWidthModeForTests('legacy-cjk');
    const output = renderToString(<MessageList blocks={[userBlock]} />);
    expect(output).toContain('> 你好');
    expect(output).not.toContain('▍');
  });

  it('多行用户消息：续行两格缩进对齐', () => {
    setTerminalWidthModeForTests('narrow');
    const block: UiBlock = { id: 1, kind: 'user', text: '第一行\n第二行' };
    const output = renderToString(<MessageList blocks={[block]} />);
    expect(output).toContain('▍ 第一行');
    expect(output).toContain('  第二行');
  });

  it('assistant 块走 markdown 渲染：标记符号不上屏，heading 着色', () => {
    setThemeForTests(rich);
    setTerminalWidthModeForTests('narrow');
    const block: UiBlock = {
      id: 1,
      kind: 'assistant',
      text: '# 标题\n\n**粗体** 文本',
      reasoning: null,
      continuation: false,
    };
    withChalkLevel(3, () => {
      const output = renderToString(<MessageList blocks={[block]} />);
      expect(output).toContain('标题');
      // 「粗体」与「 文本」分属不同样式段，中间隔着 SGR 序列，分别断言
      expect(output).toContain('粗体');
      expect(output).toContain('文本');
      expect(output).not.toContain('**');
      expect(output).toContain(hexToSgr(rich.markdown.heading));
    });
  });

  it('assistant 的 reasoning 保持 dim italic 纯文本（不解析 markdown）', () => {
    setThemeForTests(rich);
    setTerminalWidthModeForTests('narrow');
    const block: UiBlock = {
      id: 1,
      kind: 'assistant',
      text: '回复',
      reasoning: '**思考** 原文',
      continuation: false,
    };
    const output = renderToString(<MessageList blocks={[block]} />);
    expect(output).toContain('**思考** 原文');
  });
});

describe('ApprovalDialog：diff 着色与键位提示', () => {
  const editRequest = {
    id: 'c1',
    toolName: 'edit',
    describeCall: 'Edit a.ts',
    input: { path: 'a.ts', old_string: '旧行', new_string: '新行' },
    reason: 'edit 需要确认',
  };

  it('edit 预览：- 行 diffRemove 色、+ 行 diffAdd 色，路径行保持 dim', () => {
    setThemeForTests(rich);
    setTerminalWidthModeForTests('narrow');
    withChalkLevel(3, () => {
      const output = renderToString(
        <ApprovalDialog request={editRequest} cwd={process.cwd()} onReply={() => {}} />,
      );
      expect(output).toContain('- 旧行');
      expect(output).toContain('+ 新行');
      expect(output).toContain(hexToSgr(rich.markdown.diffRemove));
      expect(output).toContain(hexToSgr(rich.markdown.diffAdd));
    });
  });

  it('底部键位提示行：dim 色、ASCII 分隔', () => {
    setThemeForTests(rich);
    setTerminalWidthModeForTests('narrow');
    withChalkLevel(3, () => {
      const output = renderToString(
        <ApprovalDialog request={editRequest} cwd={process.cwd()} onReply={() => {}} />,
      );
      expect(output).toContain('1 Yes | 2 不再询问 | 3 拒绝');
    });
  });

  it('非 edit 工具不做 diff 着色（bash 命令以 +/- 开头也保持 dim）', () => {
    setThemeForTests(rich);
    setTerminalWidthModeForTests('narrow');
    withChalkLevel(3, () => {
      const output = renderToString(
        <ApprovalDialog
          request={{
            id: 'c2',
            toolName: 'bash',
            describeCall: 'Bash +x',
            input: { command: '+ 加\n- 减' },
            reason: 'r',
          }}
          cwd={process.cwd()}
          onReply={() => {}}
        />,
      );
      expect(output).toContain('+ 加');
      expect(output).not.toContain(hexToSgr(rich.markdown.diffAdd));
      expect(output).not.toContain(hexToSgr(rich.markdown.diffRemove));
    });
  });

  it('basic 主题：diff 用命名色，无任何真彩序列', () => {
    setThemeForTests(basic);
    setTerminalWidthModeForTests('narrow');
    withChalkLevel(1, () => {
      const output = renderToString(
        <ApprovalDialog request={editRequest} cwd={process.cwd()} onReply={() => {}} />,
      );
      expect(output).not.toContain('38;2;');
      expect(output).not.toContain('48;2;');
      expect(output).toContain('\x1b[31m'); // diffRemove = red
      expect(output).toContain('\x1b[32m'); // diffAdd = green
    });
  });
});
