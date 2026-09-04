import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { MessageList } from '#/tui/components/MessageList';
import { PromptInput } from '#/tui/components/PromptInput';
import { StatusBar } from '#/tui/components/StatusBar';
import { TodoList } from '#/tui/components/TodoList';
import { useTerminalTextWrap } from '#/tui/terminal-text';

describe('memo 契约（流式 delta 期间子树不重渲的前提）', () => {
  it.each([
    ['MessageList', MessageList],
    ['PromptInput', PromptInput],
    ['TodoList', TodoList],
    ['StatusBar', StatusBar],
  ])('%s 导出为 React.memo 组件', (_name, component) => {
    expect((component as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});

describe('useTerminalTextWrap 引用稳定', () => {
  it('跨渲染返回同一函数（useCallback 固定），功能不变', () => {
    const wraps: Array<(text: string, reserve?: number) => string> = [];
    function Probe() {
      wraps.push(useTerminalTextWrap());
      return <Text>probe</Text>;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    rerender(<Probe />);
    expect(wraps.length).toBeGreaterThanOrEqual(3);
    expect(wraps[1]).toBe(wraps[0]);
    expect(wraps[2]).toBe(wraps[0]);
    // 功能未变：sanitize 剥控制字符 + 折行照常
    expect(wraps[0]!('abc\x07def')).toBe('abcdef');
  });
});
