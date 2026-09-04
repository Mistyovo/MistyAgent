import { Box, Static, Text } from 'ink';

import type { ToolBlock, UiBlock } from '../controllers/session-reducer';
import { useTerminalTextWrap } from '../terminal-text';

const OUTPUT_PREVIEW_LINES = 3;

function ToolBlockView({ block }: { block: ToolBlock }) {
  const wrap = useTerminalTextWrap();
  const head =
    block.status === 'running'
      ? { color: 'yellow' as const, suffix: ' …' }
      : block.isError
        ? { color: 'red' as const, suffix: '（失败）' }
        : { color: undefined, suffix: block.durationMs === null ? '' : `（${block.durationMs}ms）` };
  const output = block.output ?? '';
  const lines = output.split('\n');
  const preview = lines.slice(0, OUTPUT_PREVIEW_LINES);
  const hidden = lines.length - preview.length;
  return (
    <Box flexDirection="column">
      <Text {...(head.color === undefined ? {} : { color: head.color })}>
        {wrap(`⏵ ${block.description}${head.suffix}`)}
      </Text>
      {block.status === 'done' && output !== '' && (
        <Box flexDirection="column" marginLeft={2}>
          {preview.map((line, index) => (
            <Text key={index} {...(block.isError ? { color: 'red' as const } : { dimColor: true })}>
              {wrap(line, 2)}
            </Text>
          ))}
          {hidden > 0 && <Text dimColor>… 还有 {hidden} 行</Text>}
        </Box>
      )}
    </Box>
  );
}

function BlockView({ block }: { block: UiBlock }) {
  const wrap = useTerminalTextWrap();
  switch (block.kind) {
    case 'user': {
      const lines = wrap(block.text, 2).split('\n');
      return (
        <Box flexDirection="column">
          {lines.map((line, index) => (
            <Text key={index} color="green">
              {index === 0 ? '> ' : '  '}
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
          {text !== '' && <Text>{wrap(text)}</Text>}
        </Box>
      );
    }
    case 'tool':
      return <ToolBlockView block={block} />;
    case 'error':
      return <Text color="red">{wrap(`✗ ${block.message}`)}</Text>;
    case 'notice':
      return <Text dimColor>{wrap(`— ${block.text}`)}</Text>;
  }
}

/** 已完成的消息区：进 ink Static，渲染一次后不再重绘 */
export function MessageList({ blocks }: { blocks: UiBlock[] }) {
  return (
    <Static items={blocks}>
      {(block) => (
        <Box key={block.id} marginTop={1}>
          <BlockView block={block} />
        </Box>
      )}
    </Static>
  );
}
