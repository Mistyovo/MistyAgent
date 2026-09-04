import { memo } from 'react';

import { Box, Static, Text } from 'ink';

import { TOOL_OUTPUT_PREVIEW_LINES } from '#/core/output-spill';

import type { ToolBlock, UiBlock } from '../controllers/session-reducer';
import { getTerminalWidthMode, useTerminalTextWrap } from '../terminal-text';
import { getTheme } from '../theme';

import { Markdown } from './Markdown';

const OUTPUT_PREVIEW_LINES = TOOL_OUTPUT_PREVIEW_LINES;

function ToolBlockView({ block }: { block: ToolBlock }) {
  const wrap = useTerminalTextWrap();
  const theme = getTheme();
  const head =
    block.status === 'running'
      ? { color: theme.warning, suffix: ' …' }
      : block.isError
        ? { color: theme.error, suffix: '（失败）' }
        : { color: theme.toolHead, suffix: block.durationMs === null ? '' : `（${block.durationMs}ms）` };
  const output = block.output ?? '';
  const lines = output.split('\n');
  const preview = lines.slice(0, OUTPUT_PREVIEW_LINES);
  const hidden = lines.length - preview.length;
  return (
    <Box flexDirection="column">
      <Text color={head.color}>
        {wrap(`⏵ ${block.description}${head.suffix}`)}
      </Text>
      {block.status === 'done' && output !== '' && (
        <Box flexDirection="column" marginLeft={2}>
          {preview.map((line, index) => (
            <Text key={index} {...(block.isError ? { color: theme.error } : { dimColor: true })}>
              {wrap(line, 2)}
            </Text>
          ))}
          {hidden > 0 && (
            <Text dimColor>
              {wrap(
                block.outputFile === null
                  ? `… 还有 ${hidden} 行`
                  : `… 还有 ${hidden} 行，完整输出: ${block.outputFile}`,
                2,
              )}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function BlockView({ block }: { block: UiBlock }) {
  const wrap = useTerminalTextWrap();
  const theme = getTheme();
  switch (block.kind) {
    case 'user': {
      // 左侧色条风格：老式 conhost 把 ▍ 按 2 格渲染且观感差，回退 '>'；前缀恒占 2 格
      const marker = getTerminalWidthMode() === 'legacy-cjk' ? '>' : '▍';
      const lines = wrap(block.text, 2).split('\n');
      return (
        <Box flexDirection="column">
          {lines.map((line, index) => (
            <Text key={index} color={theme.userText}>
              {index === 0 ? <Text color={theme.userMarker}>{`${marker} `}</Text> : '  '}
              {line}
            </Text>
          ))}
        </Box>
      );
    }
    case 'assistant': {
      // 流式缓冲冲刷时尾部可能带换行，直接渲染会在 Static 区留下永久空行
      const reasoning = block.reasoning?.trimEnd() ?? null;
      const text = block.text.trimEnd();
      return (
        <Box flexDirection="column">
          {reasoning !== null && reasoning !== '' && (
            <Text dimColor italic>
              {wrap(reasoning)}
            </Text>
          )}
          {text !== '' && <Markdown text={text} />}
        </Box>
      );
    }
    case 'tool':
      return <ToolBlockView block={block} />;
    case 'error':
      return <Text color={theme.error}>{wrap(`✗ ${block.message}`)}</Text>;
    case 'notice':
      return <Text dimColor>{wrap(`— ${block.text}`)}</Text>;
  }
}

/** 已完成的消息区：进 ink Static，渲染一次后不再重绘。
 *  assistant 续块（流式增量冲刷的后续段）不留块间距，拼回一整段的视觉效果 */
export const MessageList = memo(function MessageList({ blocks }: { blocks: UiBlock[] }) {
  return (
    <Static items={blocks}>
      {(block) => (
        <Box key={block.id} marginTop={block.kind === 'assistant' && block.continuation ? 0 : 1}>
          <BlockView block={block} />
        </Box>
      )}
    </Static>
  );
});
