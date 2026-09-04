import { memo, useMemo } from 'react';

import { Box, Text } from 'ink';

import { renderMarkdown } from '../markdown/render-markdown';
import type { StyledSegment } from '../markdown/styled';
import { getTerminalWidthMode, useTerminalColumns } from '../terminal-text';
import { getTheme } from '../theme';

interface SegmentInkProps {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dimColor?: boolean;
}

function segmentInkProps(segment: StyledSegment): SegmentInkProps {
  const props: SegmentInkProps = {};
  if (segment.color !== undefined) {
    props.color = segment.color;
  }
  if (segment.backgroundColor !== undefined) {
    props.backgroundColor = segment.backgroundColor;
  }
  if (segment.bold === true) {
    props.bold = true;
  }
  if (segment.italic === true) {
    props.italic = true;
  }
  if (segment.underline === true) {
    props.underline = true;
  }
  if (segment.strikethrough === true) {
    props.strikethrough = true;
  }
  if (segment.dim === true) {
    props.dimColor = true;
  }
  return props;
}

/**
 * assistant 消息的 markdown 渲染。解析+折行结果 useMemo 缓存：
 * MessageList 里进 Static 的块只渲染一次；流式期间由 StreamingArea 按纯文本
 * 渲染，不经过本组件，避免每个节流帧全量解析。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const columns = useTerminalColumns();
  const mode = getTerminalWidthMode();
  const theme = getTheme();
  const lines = useMemo(
    () => renderMarkdown(text, { maxWidth: columns - 1, mode, theme }),
    [text, columns, mode, theme],
  );
  return (
    <Box flexDirection="column">
      {lines.map((line, lineIndex) => (
        <Text key={lineIndex}>
          {line.length === 0
            ? ' '
            : line.map((segment, segmentIndex) => (
                <Text key={segmentIndex} {...segmentInkProps(segment)}>
                  {segment.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
});
