import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { QuestionReply, QuestionRequest } from '#/core/question';
import { QuestionDialog } from '#/tui/components/QuestionDialog';

function makeRequest(overrides?: Partial<QuestionRequest>): QuestionRequest {
  return {
    id: 'q1',
    question: '选哪个方案？',
    options: [
      { label: '甲', description: '保守路线' },
      { label: '乙' },
      { label: '丙' },
    ],
    ...overrides,
  };
}

/** 挂载弹窗并收集 onReply；stdin 按键驱动交互 */
function mountDialog(request: QuestionRequest) {
  const replies: QuestionReply[] = [];
  const view = render(
    <QuestionDialog
      request={request}
      onReply={(reply) => {
        replies.push(reply);
      }}
    />,
  );
  return { ...view, replies };
}

describe('QuestionDialog', () => {
  it('渲染：问题、选项（含描述）与单选提示上屏', () => {
    const { lastFrame } = mountDialog(makeRequest());
    const frame = lastFrame()!;
    expect(frame).toContain('提问：选哪个方案？');
    expect(frame).toContain('1. 甲 — 保守路线');
    expect(frame).toContain('2. 乙');
    expect(frame).toContain('3. 丙');
    expect(frame).toContain('1-4 直选');
    expect(frame).toContain('Esc 跳过');
  });

  it('单选：数字键直选立即确认', async () => {
    const { stdin, replies } = mountDialog(makeRequest());
    stdin.write('2');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ answers: ['乙'] }]);
    });
  });

  it('单选：↓ 移动高亮后 Enter 确认', async () => {
    const { stdin, lastFrame, replies } = mountDialog(makeRequest());
    stdin.write('\x1b[B'); // ↓
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 2. 乙');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ answers: ['乙'] }]);
    });
  });

  it('单选：↑ 从首项回绕到末项', async () => {
    const { stdin, lastFrame, replies } = mountDialog(makeRequest());
    stdin.write('\x1b[A'); // ↑
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 3. 丙');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ answers: ['丙'] }]);
    });
  });

  it('Esc 跳过：回复 cancelled', async () => {
    const { stdin, replies } = mountDialog(makeRequest());
    stdin.write('\x1b');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ cancelled: true }]);
    });
  });

  it('多选：空格与数字键勾选，Enter 按选项顺序汇总', async () => {
    const { stdin, lastFrame, replies } = mountDialog(makeRequest({ multiSelect: true }));
    expect(lastFrame()).toContain('空格/1-4 勾选');
    stdin.write(' '); // 勾选高亮项「甲」
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('[x] 甲');
    });
    stdin.write('3'); // 数字键等效勾选「丙」
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('[x] 丙');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ answers: ['甲', '丙'] }]);
    });
  });

  it('多选：重复勾选取消标记', async () => {
    const { stdin, lastFrame, replies } = mountDialog(makeRequest({ multiSelect: true }));
    stdin.write('1'); // 勾选「甲」
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('[x] 甲');
    });
    stdin.write('1'); // 再按取消
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('[ ] 甲');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ answers: [] }]);
    });
  });

  it('超出选项数的数字键不产生回复', async () => {
    const { stdin, replies } = mountDialog(makeRequest());
    stdin.write('4');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(replies).toEqual([]);
  });
});
