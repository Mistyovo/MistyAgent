import { useEffect, useState } from 'react';

import { Box, Text } from 'ink';

import type { StreamingState } from '../controllers/session-reducer';
import { completeLinesOnly } from '../controllers/stream-utils';
import { getTerminalWidthMode, useTerminalTextWrap } from '../terminal-text';
import { getTheme } from '../theme';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];

/** 老式 Windows 控制台（GBK 点阵）对 braille 字符支持差，回退 ASCII；模式判定与 terminal-text 统一 */
function spinnerFrames(): string[] {
  return getTerminalWidthMode() === 'legacy-cjk' ? ASCII_FRAMES : BRAILLE_FRAMES;
}

function Spinner({ label }: { label: string }) {
  const [index, setIndex] = useState(0);
  const frames = spinnerFrames();
  const theme = getTheme();
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % frames.length);
    }, 80);
    return () => {
      clearInterval(timer);
    };
  }, [frames.length]);
  return <Text color={theme.spinner}>{`${frames[index % frames.length] ?? ''} ${label}`}</Text>;
}

/**
 * 进行中的流式输出区。借鉴 Claude Code 的防抖动技巧：
 * 文本只渲染到最后一个换行符，完整行才上屏；
 * 只有不完整的尾部行时退化为 spinner（Thinking… / Responding…）。
 */
export function StreamingArea({ streaming }: { streaming: StreamingState }) {
  const wrap = useTerminalTextWrap();
  if (!streaming.active) {
    return null;
  }
  const reasoning = completeLinesOnly(streaming.reasoning);
  const text = completeLinesOnly(streaming.text);
  return (
    <Box flexDirection="column" marginTop={1}>
      {reasoning.complete !== '' && (
        <Text dimColor italic>
          {wrap(reasoning.complete)}
        </Text>
      )}
      {text.complete !== '' ? (
        <Text>{wrap(text.complete)}</Text>
      ) : (
        <Spinner label={streaming.text === '' ? 'Thinking…' : 'Responding…'} />
      )}
    </Box>
  );
}
