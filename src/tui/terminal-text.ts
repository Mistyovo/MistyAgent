import { eastAsianWidth } from 'get-east-asian-width';
import { useStdout } from 'ink';

/**
 * 终端安全文本层。
 *
 * 背景：ink 按 string-width（East Asian Ambiguous = 1 格）预算行宽并据
 * 逻辑行数 eraseLines 重绘；中文 cmd.exe 老式 conhost 把歧义宽字符
 * （… —— ─ │ “” 等）按 2 格物理渲染，且满宽即折行。凡物理行数与 ink
 * 逻辑行数不一致，eraseLines 就少擦 → 残帧/空白行累积。
 *
 * 约定：上屏的每一行，物理宽度必须 ≤ 终端列数 - 1——物理不折行、
 * ink 不重排，两边行数恒等。上游不可控文本（模型输出、工具输出、bash
 * 命令）进渲染前必须过本层：ink 只剥 CSI/OSC 转义序列，\r、\x0b、\x07
 * 等裸控制字符会原样写进输出，同样打破行数恒等。
 */

export type TerminalWidthMode = 'narrow' | 'legacy-cjk';

let widthModeOverride: TerminalWidthMode | null = null;

/** 测试注入宽度模式（虚拟终端按模式模拟物理渲染，组件侧必须按同一模式预算） */
export function setTerminalWidthModeForTests(mode: TerminalWidthMode | null): void {
  widthModeOverride = mode;
}

/** 老式 Windows 控制台（无 Windows Terminal / TERM_PROGRAM）按 GBK 点阵把歧义字符渲染为 2 格 */
export function getTerminalWidthMode(): TerminalWidthMode {
  if (widthModeOverride !== null) {
    return widthModeOverride;
  }
  return process.platform === 'win32' &&
    process.env.WT_SESSION === undefined &&
    process.env.TERM_PROGRAM === undefined
    ? 'legacy-cjk'
    : 'narrow';
}

/** 当前终端列数；renderToString/管道等无 TTY 场景回退 80 */
export function useTerminalColumns(): number {
  const { stdout } = useStdout();
  const columns = (stdout as { columns?: number } | undefined)?.columns;
  return typeof columns === 'number' && columns > 0 ? Math.floor(columns) : 80;
}

/* eslint-disable no-control-regex -- 本层职责就是识别并剥离 ANSI/控制字符 */
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_CHARSET = /\x1b[()#%][0-?]?/g;
const ANSI_ESC_CHAR = /\x1b./gs;
const C1_CONTROLS = /[\u0080-\u009f]/g;
// \n 保留（结构字符）；\t 单独展开为空格（物理制表位 8 格与预算不符）
const C0_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** 剥掉 ANSI 转义序列与裸控制字符（\n 除外），\t 展开为 4 空格，\r 丢弃 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_CHARSET, '')
    .replace(ANSI_ESC_CHAR, '')
    .replace('\x1b', '')
    .replace(C1_CONTROLS, '')
    .replace(/\t/g, '    ')
    .replace(C0_CONTROLS, '');
}

/** 按终端物理语义测行宽（legacy-cjk 下歧义字符 2 格；组合符/控制符 0 格） */
export function measureTerminalWidth(text: string, mode: TerminalWidthMode): number {
  let width = 0;
  for (const ch of text) {
    width += Math.max(
      0,
      eastAsianWidth(ch.codePointAt(0)!, { ambiguousAsWide: mode === 'legacy-cjk' }),
    );
  }
  return width;
}

/** 单行硬折行：按物理宽度切成 ≤ maxWidth 格的分段（至少返回一段） */
export function wrapTerminalLine(
  line: string,
  maxWidth: number,
  mode: TerminalWidthMode,
): string[] {
  const budget = Math.max(1, maxWidth);
  const segments: string[] = [];
  let current = '';
  let width = 0;
  for (const ch of line) {
    const charWidth = measureTerminalWidth(ch, mode);
    if (current !== '' && width + charWidth > budget) {
      segments.push(current);
      current = '';
      width = 0;
    }
    current += ch;
    width += charWidth;
  }
  segments.push(current);
  return segments;
}

/** sanitize + 按 \n 分行 + 逐行硬折行，返回可直接进 <Text> 的多行文本 */
export function wrapTerminalText(
  text: string,
  maxWidth: number,
  mode: TerminalWidthMode,
): string {
  return sanitizeTerminalText(text)
    .split('\n')
    .map((line) => wrapTerminalLine(line, maxWidth, mode).join('\n'))
    .join('\n');
}

/**
 * 组件侧入口：sanitize + 折行，预算 = 列数 - 1 - reserve。
 * reserve 是该行内容之外已占用的物理格数（前缀、缩进、边框+padding 等）。
 */
export function useTerminalTextWrap(): (text: string, reserve?: number) => string {
  const columns = useTerminalColumns();
  const mode = getTerminalWidthMode();
  return (text, reserve = 0) => wrapTerminalText(text, columns - 1 - reserve, mode);
}

export interface WrappedCursorLine {
  /** 折行后的分段（至少一段） */
  segments: string[];
  /** 光标所在分段下标 */
  cursorSegment: number;
  /** 光标在分段内的列（string offset，供切片渲染反显光标） */
  cursorCol: number;
}

/**
 * 输入框用：物理折行并把线性 col 换算到（分段, 段内列）。
 * col 落在折行缝上时归入后一段（继续输入的字符也从新段开始）。
 */
export function wrapTerminalLineWithCursor(
  line: string,
  col: number,
  maxWidth: number,
  mode: TerminalWidthMode,
): WrappedCursorLine {
  const segments = wrapTerminalLine(line, maxWidth, mode);
  const starts: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    starts.push(offset);
    offset += segment.length;
  }
  let cursorSegment = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (starts[index]! <= col) {
      cursorSegment = index;
    }
  }
  const segment = segments[cursorSegment]!;
  return {
    segments,
    cursorSegment,
    cursorCol: Math.min(col - starts[cursorSegment]!, segment.length),
  };
}

/** 超宽截断（补 …，宽度按终端模式计），用于状态栏等单行预算场景 */
export function truncateTerminalText(
  text: string,
  maxWidth: number,
  mode: TerminalWidthMode,
): string {
  const clean = sanitizeTerminalText(text);
  if (measureTerminalWidth(clean, mode) <= maxWidth) {
    return clean;
  }
  if (maxWidth <= 1) {
    return '';
  }
  const budget = maxWidth - measureTerminalWidth('…', mode);
  let out = '';
  let width = 0;
  for (const ch of clean) {
    const charWidth = measureTerminalWidth(ch, mode);
    if (width + charWidth > budget) {
      break;
    }
    out += ch;
    width += charWidth;
  }
  return `${out}…`;
}
