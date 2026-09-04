import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Session } from '#/core/session/session';
import { TodoStore } from '#/core/todos';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { defineTool } from '#/core/tools/tool';
import { App } from '#/tui/App';
import { getTerminalWidthMode } from '#/tui/terminal-text';
import type { ChatProvider } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from '../core/fake-provider';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 剥掉全部空白：物理折行会断开长路径，wrap 后再比较时用它归一化 */
const flat = (s: string): string => s.replace(/\s+/g, '');

/** 用户消息前缀符号随终端宽度模式切换（▍ / 老式 conhost 回退 >） */
const userMarker = (): string => (getTerminalWidthMode() === 'legacy-cjk' ? '>' : '▍');

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
      expect(lastFrame()).toContain(`${userMarker()} hello`);
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

  it('模型 fallback：状态栏切到备用模型并落提示，turn 结束后回到主模型', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    // 第二次响应手动控速，留出观察状态栏 fallback 中间态的窗口
    const provider: ChatProvider = {
      async *generate() {
        calls += 1;
        if (calls === 1) {
          yield {
            type: 'error' as const,
            error: Object.assign(new Error('model not found'), { status: 404 }),
          };
          return;
        }
        await gate;
        yield { type: 'text-delta' as const, text: '备用模型完成' };
        yield {
          type: 'done' as const,
          usage: null,
          finishReason: 'completed' as const,
          rawFinishReason: 'stop',
        };
      },
    };
    const registry = createBuiltinRegistry();
    const session = new Session({
      provider,
      model: 'primary-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
      fallbackModels: ['backup-model'],
    });
    const { lastFrame, stdin } = render(
      <App session={session} registry={registry} model="primary-model" cwd={process.cwd()} />,
    );

    expect(lastFrame()).toContain('primary-model  ? default');
    stdin.write('go');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('go');
    });
    stdin.write('\r');
    // fallback 后、备用模型响应到达前：状态栏是备用模型，Static 区有切换提示
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('已切换到 backup-model');
      expect(lastFrame()).toContain('backup-model  ? default');
    });
    release();
    // fallback 仅当前 turn 生效：turn 结束后状态栏回到 session 主模型
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('备用模型完成');
      expect(lastFrame()).toContain('primary-model  ? default');
    });
    expect(session.getModel()).toBe('primary-model');
  });

  it('粘贴的多行 / 开头文本不误判为斜杠命令，按普通消息进 session', async () => {
    const provider = new FakeProvider([textStep('收到')]);
    const { lastFrame, stdin } = makeApp(provider);
    // 粘贴一次性到达（含 \n）：不走 /help 命令
    stdin.write('/help\n第二行');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('第二行');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('收到');
    });
    expect(lastFrame()).not.toContain('可用命令');
    const userMessage = provider.requests[0]?.messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toBe('/help\n第二行');
  });

  it('单行未知斜杠命令：提示未知命令，不进模型（现状语义保持）', async () => {
    const provider = new FakeProvider([textStep('不应到达')]);
    const { lastFrame, stdin } = makeApp(provider);
    stdin.write('/nosuchcmd');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('/nosuchcmd');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('未知命令：/nosuchcmd');
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('空闲时 Esc 清空当前输入（不中断、不提交）', async () => {
    const provider = new FakeProvider([textStep('ok')]);
    const { lastFrame, stdin } = makeApp(provider);
    stdin.write('draft');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('draft');
    });
    stdin.write('\x1b');
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('draft');
    });
    stdin.write('\r'); // 空输入不提交
    await sleep(80);
    expect(provider.requests).toHaveLength(0);
  });

  it('弹窗期间 Ctrl+C：第一下关弹窗（按拒绝）并中断 turn、预位退出，第二下退出', async () => {
    const provider = new FakeProvider([
      [
        { type: 'tool-call-start', index: 0, id: 'call_1', name: 'bash' },
        { type: 'tool-call-delta', index: 0, argumentsDelta: '{"command":"echo ok-from-tool"}' },
        { type: 'done', usage: null, finishReason: 'tool-calls', rawFinishReason: 'tool_calls' },
      ],
      textStep('不应到达'),
    ]);
    const { lastFrame, stdin, frames } = makeApp(provider);
    stdin.write('run');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('run');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('需要审批：Bash echo ok-from-tool');
    });
    // 弹窗期间其他全局键位仍禁用：Shift+Tab 不切权限模式
    stdin.write('\x1b[Z');
    await sleep(80);
    expect(lastFrame()).not.toContain('⏵ accept edits');
    // 第一下 Ctrl+C：弹窗按拒绝关闭、turn 中断、进入退出预位
    stdin.write('\x03');
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('需要审批：Bash echo ok-from-tool');
      expect(lastFrame()).toContain('已中断');
      expect(lastFrame()).toContain('再按一次 Ctrl+C 退出');
    });
    await sleep(50);
    // 第二下 Ctrl+C：退出（unmount 时落最后一帧；此后输入不再产生新帧）
    const before = frames.length;
    stdin.write('\x03');
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThan(before);
    });
    const settled = frames.length;
    stdin.write('x');
    await sleep(80);
    expect(frames.length).toBe(settled);
  });

  it('无弹窗时 Ctrl+C 双击退出（与弹窗路径合并后的统一逻辑回归）', async () => {
    const { lastFrame, stdin, frames } = makeApp(new FakeProvider([]));
    stdin.write('\x03');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('再按一次 Ctrl+C 退出');
    });
    await sleep(50);
    const before = frames.length;
    stdin.write('\x03');
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThan(before);
    });
    const settled = frames.length;
    stdin.write('x');
    await sleep(80);
    expect(frames.length).toBe(settled);
  });
});

describe('工具输出落盘展示（#13）', () => {
  it('输出超 3 行：截断行附完整输出路径，落盘文件内容完整', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'misty-spill-app-test-'));
    process.env.MISTY_OUTPUT_DIR = dir;
    try {
      const longOutput = Array.from({ length: 6 }, (_, i) => `row-${i + 1}`).join('\n');
      const stub = defineTool({
        name: 'stub_long_output',
        description: '返回固定多行输出的测试工具',
        inputSchema: z.object({}),
        call: () => Promise.resolve({ output: longOutput }),
      });
      const provider = new FakeProvider([
        toolCallStep([{ name: 'stub_long_output', arguments: '{}' }]),
        textStep('完成'),
      ]);
      const registry = createBuiltinRegistry();
      registry.register(stub);
      const session = new Session({
        provider,
        model: 'fake-model',
        systemPrompt: 'system',
        tools: registry.list(),
        cwd: process.cwd(),
        // 自定义工具按写/执行处理（default 模式会弹审批），测试里绕过审批
        permission: { mode: 'bypassPermissions' },
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
        expect(lastFrame()).toContain('row-1');
        expect(lastFrame()).toContain('… 还有 3 行，完整输出: ');
      });
      // 预览只显示前 3 行，其余进了落盘文件
      expect(lastFrame()).not.toContain('row-5');
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/-\d+\.log$/);
      expect(readFileSync(join(dir, files[0]!), 'utf8')).toBe(longOutput);
      // 截断行里的路径就是落盘文件（路径可能因物理折行断开，比较时剥掉空白）
      expect(flat(lastFrame()!)).toContain(flat(`完整输出: ${join(dir, files[0]!)}`));
      await vi.waitFor(() => {
        expect(lastFrame()).toContain('完成');
      });
      // 模型侧仍看到全量输出（事件 output 不变，落盘只是展示层引用）
      const toolMessage = session.getMessages().find((m) => m.role === 'tool');
      expect(toolMessage?.role === 'tool' && toolMessage.content).toBe(longOutput);
    } finally {
      delete process.env.MISTY_OUTPUT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
