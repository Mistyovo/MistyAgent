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
});
