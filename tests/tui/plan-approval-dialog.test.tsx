import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { PlanApprovalReply, PlanApprovalRequest } from '#/core/plan-mode';
import { PlanApprovalDialog, truncatePlanLines } from '#/tui/components/PlanApprovalDialog';

function makeRequest(plan: string): PlanApprovalRequest {
  return { id: 'p1', plan };
}

/** 挂载弹窗并收集 onReply；stdin 按键驱动交互 */
function mountDialog(request: PlanApprovalRequest) {
  const replies: PlanApprovalReply[] = [];
  const view = render(
    <PlanApprovalDialog
      request={request}
      onReply={(reply) => {
        replies.push(reply);
      }}
    />,
  );
  return { ...view, replies };
}

describe('truncatePlanLines', () => {
  it('行数不超预算：原样返回', () => {
    expect(truncatePlanLines('a\nb', 2)).toBe('a\nb');
  });

  it('超预算：前 N 行 + 截断标记（含总行数）', () => {
    const plan = ['第一行', '第二行', '第三行', '第四行'].join('\n');
    expect(truncatePlanLines(plan, 2)).toBe('第一行\n第二行\n…（已截断，共 4 行）');
  });
});

describe('PlanApprovalDialog', () => {
  it('渲染：标题、计划全文、选项与提示上屏', () => {
    const { lastFrame } = mountDialog(makeRequest('# 实施计划\n1. 先做甲\n2. 再做乙'));
    const frame = lastFrame()!;
    expect(frame).toContain('计划待批准');
    expect(frame).toContain('# 实施计划');
    expect(frame).toContain('1. 先做甲');
    expect(frame).toContain('2. 再做乙');
    expect(frame).toContain('1. Approve');
    expect(frame).toContain('2. Reject');
    expect(frame).toContain('Esc 拒绝');
  });

  it('超长计划按可视高度截断，补总行数标记', () => {
    const plan = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 步`).join('\n');
    const { lastFrame } = mountDialog(makeRequest(plan));
    const frame = lastFrame()!;
    expect(frame).toContain('…（已截断，共 30 行）');
    expect(frame).toContain('第 1 步');
    // 无 TTY 的测试环境按 24 行终端预算：第 13 步及以后不上屏
    expect(frame).not.toContain('第 13 步');
  });

  it('数字键 1 直接批准', async () => {
    const { stdin, replies } = mountDialog(makeRequest('# 计划'));
    stdin.write('1');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ approved: true }]);
    });
  });

  it('数字键 2 直接拒绝', async () => {
    const { stdin, replies } = mountDialog(makeRequest('# 计划'));
    stdin.write('2');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ approved: false }]);
    });
  });

  it('→ 移动高亮后 Enter 确认拒绝', async () => {
    const { stdin, lastFrame, replies } = mountDialog(makeRequest('# 计划'));
    stdin.write('\x1b[C'); // →
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 2. Reject');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ approved: false }]);
    });
  });

  it('← 从首项回绕到末项', async () => {
    const { stdin, lastFrame } = mountDialog(makeRequest('# 计划'));
    stdin.write('\x1b[D'); // ←
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 2. Reject');
    });
  });

  it('Esc 拒绝', async () => {
    const { stdin, replies } = mountDialog(makeRequest('# 计划'));
    stdin.write('\x1b');
    await vi.waitFor(() => {
      expect(replies).toEqual([{ approved: false }]);
    });
  });

  it('超出选项数的数字键不产生回复', async () => {
    const { stdin, replies } = mountDialog(makeRequest('# 计划'));
    stdin.write('3');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(replies).toEqual([]);
  });
});
