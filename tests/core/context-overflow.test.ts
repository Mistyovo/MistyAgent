import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '#/core/events';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { ContextOverflowError, isContextOverflowError } from '#/provider/errors';
import { classifyContextOverflow } from '#/provider/openai/chat-completions';
import type { Message } from '#/provider/types';

import { FakeProvider, textStep } from './fake-provider';

function httpError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), code === undefined ? { status } : { status, code });
}

describe('classifyContextOverflow', () => {
  it.each([
    ['413 Request Entity Too Large', httpError(413, 'Request Entity Too Large')],
    [
      '400 maximum context length',
      httpError(400, "This model's maximum context length is 8192 tokens"),
    ],
    ['400 context length exceeded', httpError(400, 'context length exceeded for model')],
    ['400 prompt too long', httpError(400, 'prompt is too long')],
    ['400 带 context_length_exceeded code', httpError(400, 'bad request', 'context_length_exceeded')],
  ])('%s 识别为上下文溢出', (_label, error) => {
    const classified = classifyContextOverflow(error);
    expect(classified).toBeInstanceOf(ContextOverflowError);
    expect(classified!.cause).toBe(error);
    expect(isContextOverflowError(classified)).toBe(true);
  });

  it.each([
    ['400 其他参数错误', httpError(400, 'invalid model')],
    ['401 鉴权失败', httpError(401, 'unauthorized')],
    ['429 限流', httpError(429, 'rate limited')],
    ['500 服务端错误', httpError(500, 'internal error')],
    ['网络错误', new TypeError('fetch failed')],
    ['非对象错误', 'boom'],
  ])('%s 不识别为溢出', (_label, error) => {
    expect(classifyContextOverflow(error)).toBeNull();
  });
});

describe('isContextOverflowError', () => {
  it('识别 ContextOverflowError 实例与 duck-type code 标记', () => {
    expect(isContextOverflowError(new ContextOverflowError('x'))).toBe(true);
    expect(isContextOverflowError({ code: 'context-overflow' })).toBe(true);
    expect(isContextOverflowError(new Error('x'))).toBe(false);
    expect(isContextOverflowError({ code: 'other' })).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
  });
});

function makeOverflowDeps(
  provider: FakeProvider,
  events: AgentEvent[],
  overrides?: Partial<RunTurnDeps>,
): RunTurnDeps {
  const cwd = process.cwd();
  return {
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    cwd,
    signal: new AbortController().signal,
    dispatchEvent: (event) => events.push(event),
    permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd }),
    ...overrides,
  };
}

function overflowStep(): [{ type: 'error'; error: ContextOverflowError }] {
  return [{ type: 'error', error: new ContextOverflowError('prompt too long') }];
}

describe('context-overflow 响应式压缩重试', () => {
  it('溢出 → 强制压缩 → 重试本步成功', async () => {
    const provider = new FakeProvider([overflowStep(), textStep('ok')]);
    const events: AgentEvent[] = [];
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'padding' },
    ];
    const forceCompact = vi.fn(() => {
      messages.splice(1);
      return Promise.resolve(true);
    });
    const deps = makeOverflowDeps(provider, events, { messages, forceCompact });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(forceCompact).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(2);
    // 第二次请求使用压缩后的历史
    expect(provider.requests[1]!.messages).toHaveLength(1);
    // 溢出错误以 recoverable 事件透出，turn 继续
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: 'prompt too long',
      recoverable: true,
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'completed' });
  });

  it('压缩后仍溢出 → 第二次压缩重试 → 成功', async () => {
    const provider = new FakeProvider([overflowStep(), overflowStep(), textStep('ok')]);
    const events: AgentEvent[] = [];
    const forceCompact = vi.fn(() => Promise.resolve(true));
    const deps = makeOverflowDeps(provider, events, { forceCompact });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(forceCompact).toHaveBeenCalledTimes(2);
    expect(provider.requests).toHaveLength(3);
  });

  it('两次压缩重试后仍溢出 → error 收尾', async () => {
    const provider = new FakeProvider([overflowStep(), overflowStep(), overflowStep()]);
    const events: AgentEvent[] = [];
    const forceCompact = vi.fn(() => Promise.resolve(true));
    const deps = makeOverflowDeps(provider, events, { forceCompact });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('error');
    // 熔断：最多 2 次压缩重试，不重试第三次
    expect(forceCompact).toHaveBeenCalledTimes(2);
    expect(provider.requests).toHaveLength(3);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.at(-1)).toMatchObject({ recoverable: false });
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'error' });
  });

  it('压缩失败（返回 false）→ 立即 error 收尾，不重试', async () => {
    const provider = new FakeProvider([overflowStep(), textStep('must-not-be-used')]);
    const events: AgentEvent[] = [];
    const forceCompact = vi.fn(() => Promise.resolve(false));
    const deps = makeOverflowDeps(provider, events, { forceCompact });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('error');
    expect(forceCompact).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(1);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.at(-1)).toMatchObject({ recoverable: false });
  });

  it('未接 forceCompact 钩子时溢出直接 error 收尾', async () => {
    const provider = new FakeProvider([overflowStep(), textStep('must-not-be-used')]);
    const events: AgentEvent[] = [];
    const deps = makeOverflowDeps(provider, events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('error');
    expect(provider.requests).toHaveLength(1);
  });
});
