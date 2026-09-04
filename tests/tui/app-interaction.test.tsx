import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '#/core/session/session';
import { TodoStore } from '#/core/todos';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { App } from '#/tui/App';
import type { ChatProvider } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from '../core/fake-provider';

function makeApp(provider: ChatProvider) {
  const registry = createBuiltinRegistry();
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: registry.list(),
    cwd: process.cwd(),
  });
  return render(
    <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
  );
}

/** 与 main.ts 相同的接线：ask_user 经 sessionRef 闭包拿到 Session 的提问能力 */
function makeInteractiveApp(provider: ChatProvider) {
  let sessionRef: Session | null = null;
  const registry = createBuiltinRegistry({
    askUser: (request, signal) =>
      sessionRef?.askUser(request, signal) ?? Promise.resolve({ cancelled: true }),
  });
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: registry.list(),
    cwd: process.cwd(),
  });
  sessionRef = session;
  return {
    session,
    view: render(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
    ),
  };
}

/** 与 main.ts 相同的接线：plan 工具经 sessionRef 闭包拿到 Session 的计划模式能力 */
function makePlanApp(provider: ChatProvider) {
  let sessionRef: Session | null = null;
  const registry = createBuiltinRegistry({
    planMode: {
      isPlanMode: () => sessionRef?.isPlanMode() ?? false,
      enterPlanMode: () => sessionRef?.enterPlanMode() ?? false,
      exitPlanMode: (target) => sessionRef?.exitPlanMode(target) ?? false,
      requestPlanApproval: (request, signal) =>
        sessionRef?.requestPlanApproval(request, signal) ??
        Promise.resolve({ approved: false, feedback: '会话尚未就绪' }),
    },
  });
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: registry.list(),
    cwd: process.cwd(),
  });
  sessionRef = session;
  return {
    session,
    view: render(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
    ),
  };
}

describe('App 交互（ink-testing-library）', () => {
  it('输入提交：user block 上屏，assistant 回复完成一轮 turn', async () => {
    const { lastFrame, stdin } = makeApp(new FakeProvider([textStep('你好')]));
    stdin.write('hello');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('hello');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('> hello');
      expect(lastFrame()).toContain('你好');
    });
  });

  it('Shift+Tab 循环切换权限模式并即时反映在状态栏', async () => {
    const { lastFrame, stdin } = makeApp(new FakeProvider([]));
    expect(lastFrame()).toContain('? default');
    stdin.write('\x1b[Z');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('⏵ accept edits');
    });
    stdin.write('\x1b[Z');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('⏸ plan mode');
    });
  });

  it('Esc 中断进行中的 turn，落"已中断"提示', async () => {
    const hanging: ChatProvider = {
      async *generate(params) {
        yield { type: 'text-delta' as const, text: '开始' };
        while (params.signal?.aborted !== true) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
    const { lastFrame, stdin } = makeApp(hanging);
    stdin.write('long task');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('long task');
    });
    stdin.write('\r');
    // 不完整行不上屏（防抖动设计），退化为 Responding… spinner
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Responding…');
    });
    stdin.write('\x1b');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('已中断');
      // 中断时流式缓冲冲刷成 assistant block，部分文本可见
      expect(lastFrame()).toContain('开始');
    });
  });

  it('审批弹窗：数字键 1 放行执行，工具结果块上屏', async () => {
    const provider = new FakeProvider([
      [
        { type: 'tool-call-start', index: 0, id: 'call_1', name: 'bash' },
        { type: 'tool-call-delta', index: 0, argumentsDelta: '{"command":"echo ok-from-tool"}' },
        { type: 'done', usage: null, finishReason: 'tool-calls', rawFinishReason: 'tool_calls' },
      ],
      textStep('执行完毕'),
    ]);
    const { lastFrame, stdin } = makeApp(provider);
    stdin.write('run');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('run');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('需要审批：Bash echo ok-from-tool');
    });
    stdin.write('1');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ok-from-tool');
      expect(lastFrame()).toContain('执行完毕');
    });
  });

  it('提问弹窗：数字键直选，回答经工具结果回喂模型继续 turn', async () => {
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'ask_user',
          arguments: '{"question":"用哪个框架？","options":[{"label":"React"},{"label":"Vue"}]}',
        },
      ]),
      textStep('已按 React 继续'),
    ]);
    const { session, view } = makeInteractiveApp(provider);
    const { lastFrame, stdin } = view;
    stdin.write('go');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('go');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('提问：用哪个框架？');
      expect(lastFrame()).toContain('1. React');
    });
    stdin.write('1');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('已按 React 继续');
    });
    // 弹窗已关闭（动态区不再渲染）
    expect(lastFrame()).not.toContain('提问：用哪个框架？');
    // 回答经工具结果回喂进了消息历史
    const toolMessage = session.getMessages().find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ name: 'ask_user', content: '用户选择了：React' });
  });

  it('提问弹窗：Esc 跳过，取消结果回喂模型', async () => {
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'ask_user',
          arguments: '{"question":"要继续吗？","options":[{"label":"是"},{"label":"否"}]}',
        },
      ]),
      textStep('那我自行决定'),
    ]);
    const { session, view } = makeInteractiveApp(provider);
    const { lastFrame, stdin } = view;
    stdin.write('go');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('go');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('提问：要继续吗？');
    });
    stdin.write('\x1b');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('那我自行决定');
    });
    const toolMessage = session.getMessages().find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ name: 'ask_user', isError: true });
    expect(toolMessage?.role === 'tool' && toolMessage.content).toContain('用户取消了提问');
  });

  it('todo 工具更新经事件流渲染到状态栏上方的任务列表', async () => {
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'todo',
          arguments:
            '{"todos":[{"content":"实现功能","status":"in_progress","activeForm":"正在实现功能"},{"content":"写测试","status":"pending"}]}',
        },
      ]),
      textStep('完成了'),
    ]);
    const todoStore = new TodoStore();
    const registry = createBuiltinRegistry({ todoStore });
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
      todos: todoStore,
    });
    const { lastFrame, stdin } = render(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
    );

    stdin.write('go');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('go');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('▶ 正在实现功能');
      expect(lastFrame()).toContain('☐ 写测试');
      expect(lastFrame()).toContain('完成了');
    });
  });

  it('计划批准弹窗：计划全文上屏，数字键 1 批准后退出计划模式、状态栏同步恢复', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'enter_plan_mode', arguments: '{"reason":"先规划"}' }]),
      toolCallStep([
        { name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 实施计划\n1. 先做甲' }) },
      ]),
      textStep('开始执行'),
    ]);
    const { session, view } = makePlanApp(provider);
    const { lastFrame, stdin } = view;
    stdin.write('go');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('go');
    });
    stdin.write('\r');
    // enter_plan_mode 已把权限切到 plan：状态栏经 plan-mode-changed 事件同步
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('计划待批准');
      expect(lastFrame()).toContain('# 实施计划');
      expect(lastFrame()).toContain('1. Approve');
      expect(lastFrame()).toContain('⏸ plan mode');
    });
    stdin.write('1');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('开始执行');
      // 弹窗已关闭，状态栏恢复进入前的 default
      expect(lastFrame()).not.toContain('计划待批准');
      expect(lastFrame()).toContain('? default');
    });
    expect(session.isPlanMode()).toBe(false);
    expect(session.getPermissionMode()).toBe('default');
    const toolMessages = session.getMessages().filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.content)).toEqual([
      expect.stringContaining('已进入计划模式'),
      expect.stringContaining('计划已获批准'),
    ]);
  });

  it('计划批准弹窗：数字键 2 拒绝，拒绝结果回喂模型继续 turn（仍在计划模式）', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'enter_plan_mode', arguments: '{}' }]),
      toolCallStep([
        { name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 计划 v1' }) },
      ]),
      textStep('那我修订计划'),
    ]);
    const { session, view } = makePlanApp(provider);
    const { lastFrame, stdin } = view;
    stdin.write('go');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('go');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('计划待批准');
    });
    stdin.write('2');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('那我修订计划');
      expect(lastFrame()).toContain('⏸ plan mode');
    });
    expect(session.isPlanMode()).toBe(true);
    const rejected = session
      .getMessages()
      .find((m) => m.role === 'tool' && m.name === 'exit_plan_mode');
    expect(rejected).toMatchObject({ isError: true });
    expect(rejected?.role === 'tool' && rejected.content).toContain('计划被拒绝');
  });

  it('Shift+Tab 切到 plan 即进入完整计划模式，切走即退出', async () => {
    const provider = new FakeProvider([]);
    const registry = createBuiltinRegistry();
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
    });
    const { lastFrame, stdin } = render(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
    );

    expect(session.isPlanMode()).toBe(false);
    stdin.write('\x1b[Z'); // → acceptEdits
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('⏵ accept edits');
    });
    expect(session.isPlanMode()).toBe(false);
    stdin.write('\x1b[Z'); // → plan：进入完整计划模式
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('⏸ plan mode');
    });
    expect(session.isPlanMode()).toBe(true);
    stdin.write('\x1b[Z'); // → bypassPermissions：退出计划模式，目标是用户选择
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('⚠ bypass permissions');
    });
    expect(session.isPlanMode()).toBe(false);
    expect(session.getPermissionMode()).toBe('bypassPermissions');
  });
});
