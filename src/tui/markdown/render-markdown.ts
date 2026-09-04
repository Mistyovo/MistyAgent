import { lexer, type Token, type Tokens } from 'marked';

import { sanitizeTerminalText, type TerminalWidthMode } from '../terminal-text';
import type { Theme } from '../theme';

import { highlightCodeLines } from './highlight';
import {
  styledLineWidth,
  wrapLogicalLines,
  type LogicalLine,
  type StyledLine,
  type StyledSegment,
} from './styled';

/**
 * Ink 版 markdown 渲染器：marked lexer 拿 token 流，自己映射成样式化行。
 * 纯函数、无 React——组件层（components/Markdown.tsx）只负责把 StyledLine
 * 映射成嵌套 <Text>。折行/宽度语义全部走 terminal-text 同源测量。
 */

export interface MarkdownRenderOptions {
  /** 折行预算（物理格）；组件侧传 列数 - 1 */
  maxWidth: number;
  mode: TerminalWidthMode;
  theme: Theme;
}

type InlineStyle = Omit<StyledSegment, 'text'>;

const BLANK: LogicalLine = { hang: [], cont: [], body: [] };

export function renderMarkdown(markdown: string, options: MarkdownRenderOptions): StyledLine[] {
  const clean = sanitizeTerminalText(markdown);
  try {
    const logical = renderBlockTokens(lexer(clean), options);
    return wrapLogicalLines(logical, options.maxWidth, options.mode);
  } catch {
    // 解析异常兜底为纯文本，上屏不变量仍由 wrapLogicalLines 保证
    return wrapLogicalLines(
      clean.split('\n').map((text) => ({ hang: [], cont: [], body: textToSegments(text, {}) })),
      options.maxWidth,
      options.mode,
    );
  }
}

/** 段文本绝不含 '\n'（'\n' 一律切成断行哨兵），wrap 层据此分行 */
function pushText(out: StyledSegment[], text: string, style: InlineStyle): void {
  const parts = text.split('\n');
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      out.push({ text: '\n' });
    }
    if (part !== '') {
      out.push({ ...style, text: part });
    }
  }
}

function textToSegments(text: string, style: InlineStyle): StyledSegment[] {
  const out: StyledSegment[] = [];
  pushText(out, text, style);
  return out.filter((segment) => segment.text !== '\n');
}

/** inline token 树的纯文本（表格单元格降级、链接 label 比较用），'\n' 归并为空格 */
function flattenInlineText(tokens: readonly Token[] | undefined): string {
  if (tokens === undefined) {
    return '';
  }
  let out = '';
  for (const token of tokens) {
    if (token.type === 'br') {
      out += ' ';
    } else if ('tokens' in token && Array.isArray(token.tokens)) {
      out += flattenInlineText(token.tokens);
    } else if ('text' in token && typeof token.text === 'string') {
      out += token.text;
    }
  }
  return out.replaceAll('\n', ' ');
}

function renderInlineTokens(
  tokens: readonly Token[] | undefined,
  base: InlineStyle,
  theme: Theme,
): StyledSegment[] {
  if (tokens === undefined) {
    return [];
  }
  const out: StyledSegment[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
        pushText(out, token.text, base);
        break;
      case 'strong':
        // 父级已着色（heading/quote 内部）时不覆盖，只加粗
        out.push(
          ...renderInlineTokens(
            token.tokens,
            { ...base, bold: true, color: base.color ?? theme.markdown.bold },
            theme,
          ),
        );
        break;
      case 'em':
        out.push(...renderInlineTokens(token.tokens, { ...base, italic: true }, theme));
        break;
      case 'del':
        out.push(...renderInlineTokens(token.tokens, { ...base, strikethrough: true }, theme));
        break;
      case 'codespan':
        pushText(out, token.text, { ...base, color: theme.markdown.codeInline });
        break;
      case 'br':
        out.push({ text: '\n' });
        break;
      case 'link': {
        const linkStyle: InlineStyle = { ...base, color: theme.markdown.link, underline: true };
        out.push(...renderInlineTokens(token.tokens, linkStyle, theme));
        if (token.href !== '' && token.href !== flattenInlineText(token.tokens)) {
          pushText(out, ` (${token.href})`, { ...base, dim: true });
        }
        break;
      }
      case 'image': {
        pushText(out, token.text === '' ? token.href : token.text, {
          ...base,
          color: theme.markdown.link,
          underline: true,
        });
        if (token.text !== '' && token.text !== token.href) {
          pushText(out, ` (${token.href})`, { ...base, dim: true });
        }
        break;
      }
      default: {
        // inline html 等未特判类型：有 inline 子树就递归，否则按原文本降级
        const fallback = token as { tokens?: Token[]; text?: string; raw?: string };
        if (Array.isArray(fallback.tokens)) {
          out.push(...renderInlineTokens(fallback.tokens, base, theme));
        } else {
          pushText(out, fallback.text ?? fallback.raw ?? '', base);
        }
      }
    }
  }
  return out;
}

function plainLines(text: string, style: InlineStyle): LogicalLine[] {
  return text
    .split('\n')
    .map((line) => ({ hang: [], cont: [], body: textToSegments(line, style) }));
}

/** 代码块：高亮 → 按 预算-2 折行（框架左右各留 1 格）→ 统一描背景并补齐到块宽 */
function renderCodeBlock(
  token: Tokens.Code,
  options: MarkdownRenderOptions,
): LogicalLine[] {
  const { theme, mode } = options;
  const budget = Math.max(1, options.maxWidth);
  const code = token.text.replace(/\n+$/, '');
  const highlighted =
    highlightCodeLines(code, token.lang, theme) ??
    code.split('\n').map((line) => [{ text: line, color: theme.markdown.codeBlock }]);
  const wrapped = wrapLogicalLines(
    highlighted.map((body) => ({ hang: [], cont: [], body })),
    budget - 2,
    mode,
  );
  const contentWidth = Math.max(0, ...wrapped.map((line) => styledLineWidth(line, mode)));
  const blockWidth = Math.min(budget, contentWidth + 2);
  const backgroundColor = theme.markdown.codeBlockBg;
  return wrapped.map((line) => ({
    hang: [],
    cont: [],
    body: [
      { text: ' ', backgroundColor },
      ...line.map((segment) => ({ ...segment, backgroundColor })),
      {
        text: ' '.repeat(Math.max(1, blockWidth - 1 - styledLineWidth(line, mode))),
        backgroundColor,
      },
    ],
  }));
}

function renderQuote(
  token: Tokens.Blockquote,
  options: MarkdownRenderOptions,
): LogicalLine[] {
  const { theme } = options;
  const bar: StyledSegment = { text: '▌ ', color: theme.markdown.quote };
  return renderBlockTokens(token.tokens, options).map((line) => ({
    hang: [bar, ...line.hang],
    cont: [bar, ...line.cont],
    // 引用正文默认 quote 色；自带样式的段（粗体/行内 code 等）保持原色
    body: line.body.map((segment) =>
      segment.color === undefined ? { ...segment, color: theme.markdown.quote } : segment,
    ),
  }));
}

function renderList(
  token: Tokens.List,
  options: MarkdownRenderOptions,
): LogicalLine[] {
  const { theme, mode } = options;
  const out: LogicalLine[] = [];
  const start = typeof token.start === 'number' && token.start > 0 ? token.start : 1;
  for (const [index, item] of token.items.entries()) {
    let bullet: string;
    if (token.ordered) {
      bullet = `${start + index}.`;
    } else if (item.task) {
      bullet = item.checked === true ? '[x]' : '[ ]';
    } else {
      bullet = '•';
    }
    const hang: StyledSegment[] = [
      { text: '  ' },
      { text: `${bullet} `, color: theme.markdown.listBullet },
    ];
    const cont: StyledSegment[] = [{ text: ' '.repeat(styledLineWidth(hang, mode)) }];
    let firstLine = true;
    for (const child of item.tokens) {
      if (child.type === 'checkbox') {
        // task list 的勾选框已编码进 bullet（[x]/[ ]），跳过原始 token
        continue;
      }
      if (child.type === 'text' || child.type === 'paragraph') {
        out.push({
          hang: firstLine ? hang : cont,
          cont,
          body: renderInlineTokens(child.tokens, {}, theme),
        });
        firstLine = false;
      } else if (child.type === 'list') {
        // 嵌套列表整段右移 2 格
        out.push(
          ...renderList(child as Tokens.List, options).map((line) => ({
            hang: [{ text: '  ' }, ...line.hang],
            cont: [{ text: '  ' }, ...line.cont],
            body: line.body,
          })),
        );
        firstLine = false;
      } else {
        const pad: StyledSegment = { text: '   ' };
        out.push(
          ...renderBlockToken(child, options).map((line) => ({
            hang: [pad, ...line.hang],
            cont: [pad, ...line.cont],
            body: line.body,
          })),
        );
        firstLine = false;
      }
    }
    if (token.loose === true && index < token.items.length - 1) {
      out.push(BLANK);
    }
  }
  return out;
}

function renderTable(token: Tokens.Table): LogicalLine[] {
  const rowLine = (cells: Array<{ tokens: Token[] }>, style: InlineStyle): LogicalLine => ({
    hang: [],
    cont: [],
    body: [{ ...style, text: cells.map((cell) => flattenInlineText(cell.tokens)).join(' | ') }],
  });
  return [
    rowLine(token.header, { bold: true }),
    ...token.rows.map((row) => rowLine(row, {})),
  ];
}

function renderBlockToken(token: Token, options: MarkdownRenderOptions): LogicalLine[] {
  const { theme } = options;
  // marked 的 Token 联合带 Generic 兜底成员（type: string），switch 收窄后仍在，
  // 这里按 type 断言到具体 token；异常形状由 renderMarkdown 的 try/catch 兜底
  switch (token.type) {
    case 'heading': {
      const style: InlineStyle = { color: theme.markdown.heading, bold: true };
      return [
        {
          hang: [],
          cont: [],
          body: [
            { ...style, text: `${'#'.repeat(token.depth)} ` },
            ...renderInlineTokens(token.tokens, style, theme),
          ],
        },
      ];
    }
    case 'paragraph':
      return [{ hang: [], cont: [], body: renderInlineTokens(token.tokens, {}, theme) }];
    case 'code':
      return renderCodeBlock(token as Tokens.Code, options);
    case 'blockquote':
      return renderQuote(token as Tokens.Blockquote, options);
    case 'list':
      return renderList(token as Tokens.List, options);
    case 'hr':
      // 满宽约束：列数 - 4（maxWidth 已是 列数 - 1）
      return [
        {
          hang: [],
          cont: [],
          body: [{ text: '-'.repeat(Math.max(1, options.maxWidth - 3)), dim: true }],
        },
      ];
    case 'table':
      return renderTable(token as Tokens.Table);
    case 'text':
      return [
        {
          hang: [],
          cont: [],
          body: renderInlineTokens(token.tokens, {}, theme),
        },
      ];
    default: {
      // html/space/def 等：按原文本逐行降级
      const fallback = token as { text?: string; raw?: string };
      return plainLines(fallback.text ?? fallback.raw ?? '', {});
    }
  }
}

/** 块间恰好一空行：space token 不直接产生空行，避免连空/首尾空行 */
function renderBlockTokens(tokens: readonly Token[], options: MarkdownRenderOptions): LogicalLine[] {
  const out: LogicalLine[] = [];
  for (const token of tokens) {
    if (token.type === 'space') {
      continue;
    }
    const lines = renderBlockToken(token, options);
    if (lines.length === 0) {
      continue;
    }
    if (out.length > 0) {
      out.push(BLANK);
    }
    out.push(...lines);
  }
  return out;
}
