import { useRef, useState } from 'react';

import { Box, Text, useInput } from 'ink';

export interface PromptInputProps {
  busy: boolean;
  /** session 队列中等待执行的 turn 数，>0 时显示在输入框下方 */
  queuedCount: number;
  /** 审批弹窗打开时禁用，按键让给弹窗 */
  disabled: boolean;
  onSubmit(text: string): void;
}

/** 粘贴的文本一次性到达时做换行归一化（Windows 终端粘贴多为 \r\n） */
function normalizePasted(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
 * 多行输入框：Enter 提交；方向键移动光标；上/下翻会话内输入历史。
 * Windows 差异：ConPTY 的 Backspace 到达为 \x7f，ink 解析成 delete，
 * 因此 backspace/delete 统一按“删光标前一个字符”处理。
 */
export function PromptInput({ busy, queuedCount, disabled, onSubmit }: PromptInputProps) {
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
        const text = value.trim();
        if (text !== '') {
          historyRef.current.push(value);
          onSubmit(value);
        }
        setHistoryIndex(null);
        applyValue('', 0);
        return;
      }
      if (key.upArrow) {
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
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, index) => (
        <Text key={index}>
          <Text color="green">{index === 0 ? '> ' : '  '}</Text>
          {index === position.line ? <LineWithCursor line={line} col={position.col} /> : line}
          {index === 0 && value === '' && (
            <Text dimColor>{busy ? 'turn 进行中，输入将进入队列…' : '输入消息，Enter 发送'}</Text>
          )}
        </Text>
      ))}
      {queuedCount > 0 && <Text dimColor>  +{queuedCount} 条消息排队中</Text>}
    </Box>
  );
}
