import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '#/core/events';
import {
  initialSessionUiState,
  reduceClearBlocks,
  reduceDialogReplied,
  reduceEvent,
  reduceNotice,
  reduceStreamSync,
  reduceSubmit,
  type DescribeCall,
  type SessionUiState,
  type ToolBlock,
} from '#/tui/controllers/session-reducer';

const describeCall: DescribeCall = (name) => `desc:${name}`;

function run(state: SessionUiState, ...events: AgentEvent[]): SessionUiState {
  return events.reduce((current, event) => reduceEvent(current, event, describeCall), state);
}

const usage = { inputTokens: 10, outputTokens: 5 };

describe('reduceSubmit', () => {
  it('空闲时提交：上屏 user block，不计排队', () => {
    const state = reduceSubmit(initialSessionUiState(), 'hello');
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(state.queuedCount).toBe(0);
  });

  it('turn 进行中提交：queuedCount 增加，turn-started 后回落', () => {
    let state = run(initialSessionUiState(), { type: 'turn-started' });
    state = reduceSubmit(state, 'first');
    state = reduceSubmit(state, 'second');
    expect(state.queuedCount).toBe(2);
    state = run(state, { type: 'turn-complete', stopReason: 'completed', steps: 1, usage });
    state = run(state, { type: 'turn-started' });
    expect(state.queuedCount).toBe(1);
    state = run(state, { type: 'turn-complete', stopReason: 'completed', steps: 1, usage });
    state = run(state, { type: 'turn-started' });
    expect(state.queuedCount).toBe(0);
  });
});

describe('reduceEvent 流式聚合', () => {
  it('text/reasoning delta 累积进 streaming，不落 blocks', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'text-delta', text: 'he' },
      { type: 'text-delta', text: 'llo' },
      { type: 'reasoning-delta', text: 'think' },
    );
    expect(state.streaming).toEqual({ active: true, text: 'hello', reasoning: 'think' });
    expect(state.blocks).toHaveLength(0);
  });

  it('tool-call-started 把流式文本落成 assistant block，再排 running 工具块', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'text-delta', text: '先看看' },
      { type: 'tool-call-started', toolCallId: 'c1', name: 'bash', input: { command: 'git status' } },
    );
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ kind: 'assistant', text: '先看看' });
    expect(state.blocks[1]).toMatchObject({
      kind: 'tool',
      toolCallId: 'c1',
      description: 'desc:bash',
      status: 'running',
    });
    expect(state.streaming.text).toBe('');
  });

  it('tool-call-completed 按 toolCallId 更新对应工具块', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'tool-call-started', toolCallId: 'c1', name: 'bash', input: {} },
      { type: 'tool-call-started', toolCallId: 'c2', name: 'read', input: {} },
      { type: 'tool-call-completed', toolCallId: 'c2', name: 'read', input: {}, output: 'ok', isError: false, durationMs: 12 },
    );
    const c1 = state.blocks.find((b) => b.kind === 'tool' && b.toolCallId === 'c1') as ToolBlock;
    const c2 = state.blocks.find((b) => b.kind === 'tool' && b.toolCallId === 'c2') as ToolBlock;
    expect(c1.status).toBe('running');
    expect(c2).toMatchObject({ status: 'done', output: 'ok', isError: false, durationMs: 12 });
  });

  it('权限拒绝的调用没有 started 事件：completed 直接落完成块（拒绝在 TUI 可见）', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      {
        type: 'tool-call-completed',
        toolCallId: 'c1',
        name: 'bash',
        input: { command: 'rm -rf /' },
        output: '权限拒绝：被 deny 规则拒绝',
        isError: true,
        durationMs: 0,
      },
    );
    expect(state.blocks[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'c1',
      status: 'done',
      isError: true,
      output: '权限拒绝：被 deny 规则拒绝',
    });
  });

  it('turn-complete 冲刷流式缓冲、复位 active、记录用量', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'text-delta', text: 'done' },
      { type: 'turn-complete', stopReason: 'completed', steps: 2, usage },
    );
    expect(state.streaming).toEqual({ active: false, text: '', reasoning: '' });
    expect(state.blocks[0]).toMatchObject({ kind: 'assistant', text: 'done' });
    expect(state.lastUsage).toEqual(usage);
  });

  it('max-steps 追加 notice block', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'turn-complete', stopReason: 'max-steps', steps: 50, usage },
    );
    expect(state.blocks.some((b) => b.kind === 'notice' && b.text.includes('最大步数'))).toBe(true);
  });

  it('recoverable=false 的 error 结束 turn（此路径没有后续 turn-complete）', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'text-delta', text: 'partial' },
      { type: 'error', message: 'boom', recoverable: false },
    );
    expect(state.streaming.active).toBe(false);
    expect(state.blocks.map((b) => b.kind)).toEqual(['assistant', 'error']);
  });

  it('recoverable=true 的 error 只追加 error block，turn 继续', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'error', message: 'retry', recoverable: true },
    );
    expect(state.streaming.active).toBe(true);
    expect(state.blocks[0]).toMatchObject({ kind: 'error', message: 'retry' });
  });

  it('interrupted 冲刷缓冲、清审批、追加 notice', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'text-delta', text: 'partial' },
      {
        type: 'approval-requested',
        request: { id: 'c1', toolName: 'bash', describeCall: 'Bash x', input: {}, reason: 'r' },
      },
      { type: 'interrupted', reason: 'user' },
    );
    expect(state.streaming.active).toBe(false);
    expect(state.pendingDialogs).toEqual([]);
    expect(state.blocks.map((b) => b.kind)).toEqual(['assistant', 'notice']);
  });

  it('compacted 追加暗色 notice（含前后消息数）', () => {
    const state = run(initialSessionUiState(), {
      type: 'compacted',
      beforeCount: 12,
      afterCount: 5,
      beforeTokens: 9000,
      afterTokens: 800,
    });
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'notice' });
    expect((state.blocks[0] as { text: string }).text).toContain('12 → 5');
  });

  it('model-fallback 落暗色 notice（含 from/to 与原因），不影响 streaming', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'model-fallback', from: 'primary', to: 'backup-a', reason: 'model not found' },
    );
    expect(state.streaming.active).toBe(true);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'notice' });
    const text = (state.blocks[0] as { text: string }).text;
    expect(text).toContain('primary');
    expect(text).toContain('backup-a');
    expect(text).toContain('model not found');
  });
});

describe('弹窗队列', () => {
  const approval = { id: 'c1', toolName: 'bash', describeCall: 'Bash x', input: {}, reason: 'r' };
  const question = {
    id: 'q1',
    question: '选哪个？',
    options: [{ label: '甲' }, { label: '乙' }],
  };
  const planApproval = { id: 'p1', plan: '# 计划\n1. 第一步' };

  it('approval-requested 挂起，reduceDialogReplied 出队', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'approval-requested', request: approval },
    );
    expect(state.pendingDialogs).toEqual([{ kind: 'approval', request: approval }]);
    state = reduceDialogReplied(state);
    expect(state.pendingDialogs).toEqual([]);
  });

  it('question-asked 挂起，reduceDialogReplied 出队', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'question-asked', request: question },
    );
    expect(state.pendingDialogs).toEqual([{ kind: 'question', request: question }]);
    state = reduceDialogReplied(state);
    expect(state.pendingDialogs).toEqual([]);
  });

  it('plan-approval-requested 挂起，reduceDialogReplied 出队', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'plan-approval-requested', request: planApproval },
    );
    expect(state.pendingDialogs).toEqual([{ kind: 'plan-approval', request: planApproval }]);
    state = reduceDialogReplied(state);
    expect(state.pendingDialogs).toEqual([]);
  });

  it('审批与提问同时挂起：一次只显示队首，先到的先显示', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'question-asked', request: question },
      { type: 'approval-requested', request: approval },
    );
    expect(state.pendingDialogs.map((d) => d.kind)).toEqual(['question', 'approval']);
    state = reduceDialogReplied(state);
    expect(state.pendingDialogs.map((d) => d.kind)).toEqual(['approval']);
  });

  it('审批、提问、计划批准三类型共存：FIFO 依次露出', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'plan-approval-requested', request: planApproval },
      { type: 'approval-requested', request: approval },
      { type: 'question-asked', request: question },
    );
    expect(state.pendingDialogs.map((d) => d.kind)).toEqual([
      'plan-approval',
      'approval',
      'question',
    ]);
    state = reduceDialogReplied(state);
    expect(state.pendingDialogs.map((d) => d.kind)).toEqual(['approval', 'question']);
    state = reduceDialogReplied(state);
    expect(state.pendingDialogs.map((d) => d.kind)).toEqual(['question']);
  });

  it('interrupted 清空弹窗队列（含计划批准）', () => {
    const state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'question-asked', request: question },
      { type: 'plan-approval-requested', request: planApproval },
      { type: 'approval-requested', request: approval },
      { type: 'interrupted', reason: 'user' },
    );
    expect(state.pendingDialogs).toEqual([]);
  });

  it('plan-mode-changed 不影响 blocks / 弹窗队列 / streaming', () => {
    const before = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      { type: 'plan-approval-requested', request: planApproval },
    );
    const after = run(before, {
      type: 'plan-mode-changed',
      active: true,
      mode: 'plan',
      previousMode: 'default',
    });
    expect(after).toBe(before);
  });
});

describe('reduceStreamSync', () => {
  it('非 active 时忽略缓冲同步', () => {
    const state = reduceStreamSync(initialSessionUiState(), 'x', 'y');
    expect(state.streaming).toEqual({ active: false, text: '', reasoning: '' });
  });
});

describe('reduceNotice / reduceClearBlocks', () => {
  it('notice 落 notice block，clearBlocks 清空 Static 区', () => {
    let state = reduceNotice(initialSessionUiState(), '命令输出');
    expect(state.blocks[0]).toMatchObject({ kind: 'notice', text: '命令输出' });
    state = reduceClearBlocks(state);
    expect(state.blocks).toHaveLength(0);
  });
});

describe('todos-updated', () => {
  it('事件全量替换 state.todos，不影响 blocks 与 streaming', () => {
    let state = run(
      initialSessionUiState(),
      { type: 'turn-started' },
      {
        type: 'todos-updated',
        todos: [
          { content: '实现功能', status: 'in_progress', activeForm: '正在实现功能' },
          { content: '写测试', status: 'pending' },
        ],
      },
    );
    expect(state.todos).toEqual([
      { content: '实现功能', status: 'in_progress', activeForm: '正在实现功能' },
      { content: '写测试', status: 'pending' },
    ]);
    expect(state.blocks).toHaveLength(0);
    expect(state.streaming).toEqual({ active: true, text: '', reasoning: '' });

    state = run(state, {
      type: 'todos-updated',
      todos: [{ content: '实现功能', status: 'done' }],
    });
    expect(state.todos).toEqual([{ content: '实现功能', status: 'done' }]);

    state = run(state, { type: 'todos-updated', todos: [] });
    expect(state.todos).toEqual([]);
  });
});

describe('后台任务事件', () => {
  it('task-started 只刷新 runningTasks 计数，不上屏', () => {
    const state = run(initialSessionUiState(), {
      type: 'task-started',
      taskId: 'task_1',
      command: 'npm run build',
      pid: 1234,
      runningCount: 1,
    });
    expect(state.runningTasks).toBe(1);
    expect(state.blocks).toHaveLength(0);
  });

  it('task-finished 落暗色 notice，命令超长截断，runningTasks 同步', () => {
    const longCommand = `node build.js ${'--flag '.repeat(20)}`;
    let state = run(initialSessionUiState(), {
      type: 'task-started',
      taskId: 'task_1',
      command: longCommand,
      pid: 1234,
      runningCount: 1,
    });
    state = run(state, {
      type: 'task-finished',
      taskId: 'task_1',
      command: longCommand,
      status: 'completed',
      exitCode: 0,
      outputTail: 'done',
      runningCount: 0,
    });
    expect(state.runningTasks).toBe(0);
    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0]!;
    expect(block.kind).toBe('notice');
    if (block.kind === 'notice') {
      expect(block.text.startsWith('task task_1 已完成 (exit 0): node build.js')).toBe(true);
      expect(block.text).toContain('…');
      expect(block.text.length).toBeLessThan(longCommand.length);
    }
  });

  it('failed / killed 的 notice 文案区分状态', () => {
    const base = { taskId: 'task_2', command: 'make test', outputTail: '', runningCount: 0 };
    const failed = run(initialSessionUiState(), {
      ...base,
      type: 'task-finished',
      status: 'failed',
      exitCode: 1,
    });
    expect(failed.blocks[0]).toMatchObject({
      kind: 'notice',
      text: 'task task_2 失败 (exit 1): make test',
    });
    const killed = run(initialSessionUiState(), {
      ...base,
      type: 'task-finished',
      status: 'killed',
      exitCode: null,
    });
    expect(killed.blocks[0]).toMatchObject({
      kind: 'notice',
      text: 'task task_2 已停止: make test',
    });
  });
});
