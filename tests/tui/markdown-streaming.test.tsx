import { renderToString } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 性能契约：markdown 解析只发生在落块（Static 区）之后。
 * StreamingArea 流式期间按纯文本渲染，绝不在节流帧里跑 markdown 解析。
 */

const probe = vi.hoisted(() => ({ parses: 0 }));

vi.mock('#/tui/markdown/render-markdown', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#/tui/markdown/render-markdown')>();
  return {
    ...mod,
    renderMarkdown: (
      text: string,
      options: Parameters<typeof mod.renderMarkdown>[1],
    ): ReturnType<typeof mod.renderMarkdown> => {
      probe.parses += 1;
      return mod.renderMarkdown(text, options);
    },
  };
});

import { MessageList } from '#/tui/components/MessageList';
import { StreamingArea } from '#/tui/components/StreamingArea';
import type { UiBlock } from '#/tui/controllers/session-reducer';
import { setTerminalWidthModeForTests } from '#/tui/terminal-text';

afterEach(() => {
  setTerminalWidthModeForTests(null);
});

describe('流式期间不解析 markdown', () => {
  it('StreamingArea 渲染含 markdown 标记的完整行：0 次解析，标记原文上屏', () => {
    setTerminalWidthModeForTests('narrow');
    probe.parses = 0;
    const output = renderToString(
      <StreamingArea
        streaming={{ active: true, reasoning: '', text: '**加粗** 与 `码`\n# 标题\n' }}
      />,
    );
    expect(probe.parses).toBe(0);
    expect(output).toContain('**加粗** 与 `码`');
    expect(output).toContain('# 标题');
  });

  it('turn 完成落块后 MessageList 才解析一次', () => {
    setTerminalWidthModeForTests('narrow');
    probe.parses = 0;
    const block: UiBlock = {
      id: 1,
      kind: 'assistant',
      text: '**加粗** 文本',
      reasoning: null,
      continuation: false,
    };
    const output = renderToString(<MessageList blocks={[block]} />);
    expect(probe.parses).toBe(1);
    expect(output).toContain('加粗 文本');
    expect(output).not.toContain('**');
  });
});
