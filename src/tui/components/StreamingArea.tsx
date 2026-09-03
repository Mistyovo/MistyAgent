import { useEffect, useState } from 'react';

import { Box, Text } from 'ink';

import type { StreamingState } from '../controllers/session-reducer';
import { completeLinesOnly } from '../controllers/stream-utils';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];

/** 老式 Windows 控制台（无 Windows Terminal / TERM_PROGRAM）对 braille 字符支持差，回退 ASCII */
const FRAMES =
  process.platform === 'win32' &&
  process.env.WT_SESSION === undefined &&
  process.env.TERM_PROGRAM === undefined
    ? ASCII_FRAMES
    : BRAILLE_FRAMES;

function Spinner({ label }: { label: string }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % FRAMES.length);
    }, 80);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <Text color="cyan">{`${FRAMES[index] ?? ''} ${label}`}</Text>;
}

/**
 * 进行中的流式输出区。借鉴 Claude Code 的防抖动技巧：
 * 文本只渲染到最后一个换行符，完整行才上屏；
 * 只有不完整的尾部行时退化为 spinner（Thinking… / Responding…）。
 */
export function StreamingArea({ streaming }: { streaming: StreamingState }) {
  if (!streaming.active) {
    return null;
  }
  const reasoning = completeLinesOnly(streaming.reasoning);
  const text = completeLinesOnly(streaming.text);
  return (
    <Box flexDirection="column" marginTop={1}>
      {reasoning.complete !== '' && (
        <Text dimColor italic>
          {reasoning.complete}
        </Text>
      )}
      {text.complete !== '' ? (
        <Text>{text.complete}</Text>
      ) : (
        <Spinner label={streaming.text === '' ? 'Thinking…' : 'Responding…'} />
      )}
    </Box>
  );
}
