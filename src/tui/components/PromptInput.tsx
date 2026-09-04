import { memo, useRef, useState } from 'react';

import { Box, Text, useInput } from 'ink';

import {
  getTerminalWidthMode,
  sanitizeTerminalText,
  useTerminalColumns,
  wrapTerminalLine,
  wrapTerminalLineWithCursor,
} from '../terminal-text';
import { getTheme } from '../theme';

export interface PromptInputProps {
  busy: boolean;
  /** session 队列中等待执行的 turn 数，>0 时显示在输入框下方 */
  queuedCount: number;
  /** 审批弹窗打开时禁用，按键让给弹窗 */
  disabled: boolean;
  onSubmit(text: string): void;
}

/** 输入历史上限：最老的先出栈 */
export const HISTORY_LIMIT = 200;

/** 提交入栈：连续重复不重复入栈；超过上限时最老的出栈 */
export function pushHistoryEntry(history: string[], entry: string): void {
  if (history[history.length - 1] === entry) {
    return;
  }
  history.push(entry);
  if (history.length > HISTORY_LIMIT) {
    history.shift();
  }
}

/** 粘贴的文本一次性到达时做换行归一化（Windows 终端粘贴多为 \r\n）并剥掉控制字符 */
function normalizePasted(input: string): string {
  return sanitizeTerminalText(input.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

/** 光标定位：把线性 offset 换算成（行, 列） */
function locateCursor(lines: string[], offset: number): { line: number; col: number } {
  let rest = offset;
  for (let index = 0; index < lines.length; index += 1) {
    const length = lines[index]?.length ?? 0;
    if (rest <= length) {
      return { line: index, col: rest };
    }
    rest -= length + 1;
  }
  return { line: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0 };
}

/** （行, 列）→ 线性 offset，locateCursor 的逆运算 */
function offsetFor(lines: string[], line: number, col: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + col;
}

/** 行间上/下移的目标列：保持原列，目标行更短则落到行尾 */
function clampColumn(lines: string[], line: number, col: number): number {
  return Math.min(col, lines[line]?.length ?? 0);
}

function LineWithCursor({ line, col }: { line: string; col: number }) {
  const hasChar = col < line.length;
  return (
    <>
      {line.slice(0, col)}
      <Text inverse>{hasChar ? (line[col] ?? ' ') : ' '}</Text>
      {hasChar ? line.slice(col + 1) : ''}
    </>
  );
}

/**
 * 多行输入框。
 * - Enter 提交；Alt+Enter 插入手动换行（多数终端到达为 \x1b\r，ink 解析为
 *   meta+return；kitty 协议同）。部分终端（conhost 全屏切换等）吞掉
 *   Alt+Enter，兜底：行尾 `\` + Enter 续行（反斜杠被吃掉，换行进缓冲）
 * - ↑/↓：多行时光标不在首/末行先做行间移动（保持列，目标行短则落行尾），
 *   到首行顶/末行底才进历史导航；历史上限 HISTORY_LIMIT 条，连续重复不入栈
 * - Home/End（或 Ctrl+A/E）行首/行尾；Ctrl+U 清空；Ctrl+W 删前一个词
 * - Esc：空闲（无 turn）且输入非空时清空；busy 时让给 App 做中断
 * Windows 差异：ConPTY 的 Backspace 到达为 \x7f，ink 解析成 delete，
 * 因此 backspace/delete 统一按“删光标前一个字符”处理。
 */
export const PromptInput = memo(function PromptInput({
  busy,
  queuedCount,
  disabled,
  onSubmit,
}: PromptInputProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyRef = useRef<string[]>([]);
  const stashRef = useRef('');

  const applyValue = (next: string, nextCursor: number): void => {
    setValue(next);
    setCursor(nextCursor);
  };

  useInput(
    (input, key) => {
      if (key.return) {
        if (key.meta) {
          // Alt+Enter：手动换行
          applyValue(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1);
          return;
        }
        if (cursor === value.length && value.endsWith('\\')) {
          // 续行兜底：吃掉行尾反斜杠，换成换行
          applyValue(`${value.slice(0, -1)}\n`, value.length);
          return;
        }
        const text = value.trim();
        if (text !== '') {
          pushHistoryEntry(historyRef.current, value);
          onSubmit(value);
        }
        setHistoryIndex(null);
        applyValue('', 0);
        return;
      }
      if (key.escape) {
        // busy 时 Esc 是中断（App 处理）；弹窗打开时本组件不激活
        if (!busy && value !== '') {
          setHistoryIndex(null);
          applyValue('', 0);
        }
        return;
      }
      const lines = value.split('\n');
      const position = locateCursor(lines, cursor);
      if (key.upArrow) {
        if (position.line > 0) {
          const target = position.line - 1;
          setCursor(offsetFor(lines, target, clampColumn(lines, target, position.col)));
          return;
        }
        const history = historyRef.current;
        if (history.length === 0) {
          return;
        }
        if (historyIndex === null) {
          stashRef.current = value;
        }
        const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        const entry = history[nextIndex] ?? '';
        setHistoryIndex(nextIndex);
        applyValue(entry, entry.length);
        return;
      }
      if (key.downArrow) {
        if (position.line < lines.length - 1) {
          const target = position.line + 1;
          setCursor(offsetFor(lines, target, clampColumn(lines, target, position.col)));
          return;
        }
        if (historyIndex === null) {
          return;
        }
        if (historyIndex >= historyRef.current.length - 1) {
          setHistoryIndex(null);
          applyValue(stashRef.current, stashRef.current.length);
          return;
        }
        const nextIndex = historyIndex + 1;
        const entry = historyRef.current[nextIndex] ?? '';
        setHistoryIndex(nextIndex);
        applyValue(entry, entry.length);
        return;
      }
      if (key.home || (key.ctrl && input === 'a')) {
        setCursor(offsetFor(lines, position.line, 0));
        return;
      }
      if (key.end || (key.ctrl && input === 'e')) {
        setCursor(offsetFor(lines, position.line, lines[position.line]?.length ?? 0));
        return;
      }
      if (key.ctrl && input === 'u') {
        setHistoryIndex(null);
        applyValue('', 0);
        return;
      }
      if (key.ctrl && input === 'w') {
        // 删前一个词：先退过空白，再退过非空白
        let start = cursor;
        while (start > 0 && /\s/.test(value[start - 1]!)) {
          start -= 1;
        }
        while (start > 0 && !/\s/.test(value[start - 1]!)) {
          start -= 1;
        }
        if (start < cursor) {
          applyValue(value.slice(0, start) + value.slice(cursor), start);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((current) => Math.min(value.length, current + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor > 0) {
          applyValue(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        }
        return;
      }
      if (input === '' || key.ctrl || key.meta) {
        return;
      }
      const text = normalizePasted(input);
      applyValue(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
    },
    { isActive: !disabled },
  );

  const lines = value.split('\n');
  const position = locateCursor(lines, cursor);
  // 内容预算 = 列数 - 1（满宽折行保险）- 2（'> ' 前缀）；
  // value 入框时已 sanitize，折行不再改字符，光标 offset 保持对齐
  const budget = useTerminalColumns() - 3;
  const widthMode = getTerminalWidthMode();
  const theme = getTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.flatMap((line, index) => {
        const wrapped =
          index === position.line
            ? wrapTerminalLineWithCursor(line, position.col, budget, widthMode)
            : { segments: wrapTerminalLine(line, budget, widthMode), cursorSegment: -1, cursorCol: 0 };
        return wrapped.segments.map((segment, segmentIndex) => (
          <Text key={`${index}:${segmentIndex}`}>
            <Text {...(busy ? { dimColor: true } : { color: theme.promptMarker })}>
              {index === 0 && segmentIndex === 0 ? '> ' : '  '}
            </Text>
            {segmentIndex === wrapped.cursorSegment ? (
              <LineWithCursor line={segment} col={wrapped.cursorCol} />
            ) : (
              segment
            )}
            {index === 0 && segmentIndex === 0 && value === '' && (
              <Text dimColor>{busy ? 'turn 进行中，输入将进入队列…' : '输入消息，Enter 发送'}</Text>
            )}
          </Text>
        ));
      })}
      {queuedCount > 0 && <Text dimColor>  +{queuedCount} 条消息排队中</Text>}
    </Box>
  );
});
