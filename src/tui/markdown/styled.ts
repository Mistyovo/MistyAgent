import { measureTerminalWidth, type TerminalWidthMode } from '../terminal-text';

/**
 * 样式化行模型：markdown 渲染的中间层。
 *
 * 块渲染器产出 LogicalLine（首行前缀 hang + 续行前缀 cont + 正文段 body），
 * wrapLogicalLines 按终端物理宽度硬折行为 StyledLine（每行一组带样式段），
 * 组件层再把段映射成嵌套 <Text>。段文本在 marked 解析前已 sanitize、
 * 折行预算 = 列数 - 1，上屏不变量与 terminal-text 层一致。
 * body 中 text === '\n' 的段是显式断行哨兵（软换行 / <br>），不带上屏。
 */

export interface StyledSegment {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dim?: boolean;
}

/** 一行物理行 = 有序段序列；空数组表示空行（块间距） */
export type StyledLine = StyledSegment[];

export interface LogicalLine {
  /** 首行前缀（列表符号、引用条等，占宽计入折行预算） */
  hang: StyledSegment[];
  /** 折行后续行的前缀（与 hang 等宽的空白，或重复的引用条） */
  cont: StyledSegment[];
  body: StyledSegment[];
}

export function styledLineWidth(line: readonly StyledSegment[], mode: TerminalWidthMode): number {
  let width = 0;
  for (const segment of line) {
    width += measureTerminalWidth(segment.text, mode);
  }
  return width;
}

/** 段的纯文本拼接（测试/调试用） */
export function styledLinePlainText(line: readonly StyledSegment[]): string {
  return line.map((segment) => segment.text).join('');
}

const BREAK_SENTINEL = '\n';

function wrapOneBody(
  firstPrefix: readonly StyledSegment[],
  wrapPrefix: readonly StyledSegment[],
  body: readonly StyledSegment[],
  budget: number,
  mode: TerminalWidthMode,
  out: StyledLine[],
): void {
  const firstAvail = Math.max(1, budget - styledLineWidth(firstPrefix, mode));
  const wrapAvail = Math.max(1, budget - styledLineWidth(wrapPrefix, mode));
  let current: StyledLine = [...firstPrefix];
  let avail = firstAvail;
  let width = 0;
  for (const segment of body) {
    let buffer = '';
    for (const ch of segment.text) {
      const charWidth = Math.max(0, measureTerminalWidth(ch, mode));
      if (buffer !== '' && width + charWidth > avail) {
        current.push({ ...segment, text: buffer });
        out.push(current);
        current = [...wrapPrefix];
        avail = wrapAvail;
        width = 0;
        buffer = '';
      }
      buffer += ch;
      width += charWidth;
    }
    if (buffer !== '') {
      current.push({ ...segment, text: buffer });
    }
  }
  out.push(current);
}

/** 前缀超宽的病态嵌套（几十层列表/引用）兜底：截到预算内，保住上屏不变量 */
function clampToBudget(line: StyledLine, budget: number, mode: TerminalWidthMode): StyledLine {
  if (styledLineWidth(line, mode) <= budget) {
    return line;
  }
  const clamped: StyledLine = [];
  let width = 0;
  for (const segment of line) {
    let text = '';
    for (const ch of segment.text) {
      const charWidth = Math.max(0, measureTerminalWidth(ch, mode));
      if (width + charWidth > budget) {
        break;
      }
      text += ch;
      width += charWidth;
    }
    if (text !== '') {
      clamped.push({ ...segment, text });
    }
    if (width >= budget) {
      break;
    }
  }
  return clamped;
}

/** LogicalLine 序列 → 物理折行后的 StyledLine 序列（每行宽 ≤ maxWidth） */
export function wrapLogicalLines(
  lines: readonly LogicalLine[],
  maxWidth: number,
  mode: TerminalWidthMode,
): StyledLine[] {
  const budget = Math.max(1, maxWidth);
  const out: StyledLine[] = [];
  for (const line of lines) {
    if (line.hang.length === 0 && line.cont.length === 0 && line.body.length === 0) {
      out.push([]);
      continue;
    }
    const parts: StyledSegment[][] = [[]];
    for (const segment of line.body) {
      if (segment.text === BREAK_SENTINEL) {
        parts.push([]);
      } else {
        parts.at(-1)!.push(segment);
      }
    }
    let first = true;
    for (const part of parts) {
      wrapOneBody(first ? line.hang : line.cont, line.cont, part, budget, mode, out);
      first = false;
    }
  }
  return out.map((line) => clampToBudget(line, budget, mode));
}
