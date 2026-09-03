import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentEvent } from '#/core/events';
import { Session } from '#/core/session/session';
import { defineTool, type Tool, type ToolContext } from '#/core/tools/tool';
import type { AssistantMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

function makeSession(provider: FakeProvider, tools: Tool[] = []): Session {
  return new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools,
    cwd: process.cwd(),
    // 与权限无关的用例全部放行，避免挂起等审批
    permission: { mode: 'bypassPermissions' },
  });
}

describe('Session', () => {
  it('事件订阅与退订', async () => {
    const provider = new FakeProvider([textStep('hi'), textStep('again')]);
    const session = makeSession(provider);
    const received: AgentEvent[] = [];
    const off = session.onEvent((event) => received.push(event));

    await session.submit({ type: 'user-turn', text: 'one' });
    expect(received.some((e) => e.type === 'turn-started')).toBe(true);
    expect(received.some((e) => e.type === 'turn-complete')).toBe(true);
    const count = received.length;

    off();
    await session.submit({ type: 'user-turn', text: 'two' });
    expect(received).toHaveLength(count);
  });

  it('监听器抛异常被隔离，不影响其他监听器与 loop', async () => {
    const provider = new FakeProvider([textStep('hi')]);
    const session = makeSession(provider);
    const received: AgentEvent[] = [];
    session.onEvent(() => {
      throw new Error('listener boom');
    });
    session.onEvent((event) => received.push(event));

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(received.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('turn 进行中收到的 user-turn 排队，当前 turn 结束后自动开始', async () => {
    const provider = new FakeProvider([textStep('first'), textStep('second')]);
    const session = makeSession(provider);
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const first = session.submit({ type: 'user-turn', text: 'q1' });
    const second = session.submit({ type: 'user-turn', text: 'q2' });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.stopReason).toBe('completed');
    expect(secondResult.stopReason).toBe('completed');
    expect(provider.requests).toHaveLength(2);
    // 第二个请求能看到第一个 turn 的完整历史
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    const completes = events.map((e) => e.type);
    const firstComplete = completes.indexOf('turn-complete');
    const secondStart = completes.indexOf('turn-started', firstComplete);
    expect(secondStart).toBeGreaterThan(firstComplete);
    expect(session.getMessages().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect((session.getMessages()[1] as AssistantMessage).content).toBe('first');
  });

  it('interrupt 中断活跃 turn', async () => {
    const slowTool = defineTool({
      name: 'slow',
      description: '等待中断',
      inputSchema: z.object({}),
      accesses: () => [{ kind: 'write' }],
      call: (_input, ctx: ToolContext) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    const provider = new FakeProvider([toolCallStep([{ name: 'slow', arguments: '{}' }])]);
    const session = makeSession(provider, [slowTool]);
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const resultPromise = session.submit({ type: 'user-turn', text: 'go' });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'tool-call-started')).toBe(true);
    });
    session.interrupt();
    const result = await resultPromise;

    expect(result.stopReason).toBe('interrupted');
    expect(events.some((e) => e.type === 'interrupted')).toBe(true);
    // 中断后历史完整：assistant 的 toolCall 有对应 tool 消息
    expect(session.getMessages().map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });
});
