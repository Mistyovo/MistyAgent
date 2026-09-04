import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentEvent } from '#/core/events';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { defineTool } from '#/core/tools/tool';
import { ContextOverflowError } from '#/provider/errors';
import type { Message, StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

function makeDeps(
  provider: FakeProvider,
  events: AgentEvent[],
  overrides?: Partial<RunTurnDeps>,
): RunTurnDeps {
  return {
    provider,
    model: 'primary',
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

function httpErrorStep(status: number, message: string): StreamedMessagePart[] {
  return [{ type: 'error', error: Object.assign(new Error(message), { status }) }];
}

function overflowStep(): StreamedMessagePart[] {
  return [{ type: 'error', error: new ContextOverflowError('prompt too long') }];
}

const echoTool = defineTool({
  name: 'echo',
  description: '回显输入',
  inputSchema: z.object({ text: z.string() }),
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Echo ${input.text}`,
  call: (input) => Promise.resolve({ output: `echo:${input.text}` }),
});

describe('模型 fallback 链', () => {
  it('主模型 404（不可重试）→ 自动切备用模型重试成功', async () => {
    const provider = new FakeProvider([
      httpErrorStep(404, 'model primary not found'),
      textStep('ok'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events, { fallbackModels: ['backup-a'] });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.model)).toEqual(['primary', 'backup-a']);
    const fallback = events.find((e) => e.type === 'model-fallback');
    expect(fallback).toMatchObject({
      from: 'primary',
      to: 'backup-a',
    });
    expect(fallback?.type === 'model-fallback' && fallback.reason).toContain('not found');
    // 失败事件透出为 recoverable（turn 未因此结束）
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: 'model primary not found',
      recoverable: true,
    });
  });

  it('链式降级：备用模型也失败时继续切下一个', async () => {
    const provider = new FakeProvider([
      httpErrorStep(404, 'no primary'),
      httpErrorStep(403, 'no a'),
      textStep('ok'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events, { fallbackModels: ['backup-a', 'backup-b'] });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.model)).toEqual(['primary', 'backup-a', 'backup-b']);
    const fallbacks = events.filter((e) => e.type === 'model-fallback');
    expect(fallbacks).toHaveLength(2);
    expect(fallbacks[1]).toMatchObject({ from: 'backup-a', to: 'backup-b' });
  });

  it('链条耗尽 → error 收尾，不再多发请求', async () => {
    const provider = new FakeProvider([
      httpErrorStep(404, 'no primary'),
      httpErrorStep(404, 'no a'),
      textStep('must-not-be-used'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events, { fallbackModels: ['backup-a'] });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('error');
    expect(provider.requests).toHaveLength(2);
    const errors = events.filter((e) => e.type === 'error');
    // 链尾模型的失败事件是终结性的
    expect(errors.at(-1)).toMatchObject({ message: 'no a', recoverable: false });
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'error' });
  });

  it('5xx 在单模型内先走 chatWithRetry 预算，耗尽后才降级', async () => {
    const provider = new FakeProvider([
      httpErrorStep(500, 'boom'),
      httpErrorStep(500, 'boom'),
      httpErrorStep(500, 'boom'),
      httpErrorStep(500, 'boom'),
      textStep('ok'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events, {
      fallbackModels: ['backup-a'],
      retry: { sleep: () => Promise.resolve() },
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    // primary 独立耗尽 1+3 次尝试后才切到 backup-a
    expect(provider.requests.map((r) => r.model)).toEqual([
      'primary',
      'primary',
      'primary',
      'primary',
      'backup-a',
    ]);
    expect(events.filter((e) => e.type === 'model-fallback')).toHaveLength(1);
  });

  it('同 turn 后续 step 继续使用切换后的模型（不弹回主模型）', async () => {
    const provider = new FakeProvider([
      httpErrorStep(404, 'no primary'),
      toolCallStep([{ name: 'echo', arguments: '{"text":"hi"}' }]),
      textStep('done'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events, {
      fallbackModels: ['backup-a'],
      tools: [echoTool],
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.model)).toEqual(['primary', 'backup-a', 'backup-a']);
  });

  it('溢出优先于 fallback：压缩重试仍在原模型上进行，不消耗链', async () => {
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
    const deps = makeDeps(provider, events, {
      fallbackModels: ['backup-a'],
      messages,
      forceCompact,
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.model)).toEqual(['primary', 'primary']);
    expect(events.some((e) => e.type === 'model-fallback')).toBe(false);
    expect(forceCompact).toHaveBeenCalledTimes(1);
  });

  it('链尾模型溢出同样走压缩重试（不是 fallback 的例外）', async () => {
    const provider = new FakeProvider([
      httpErrorStep(404, 'no primary'),
      overflowStep(),
      textStep('ok'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events, {
      fallbackModels: ['backup-a'],
      forceCompact: () => Promise.resolve(true),
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.model)).toEqual(['primary', 'backup-a', 'backup-a']);
    expect(events.filter((e) => e.type === 'model-fallback')).toHaveLength(1);
  });

  it('溢出压缩未生效时直接 error 收尾，不触发 fallback', async () => {
    const provider = new FakeProvider([overflowStep(), textStep('must-not-be-used')]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events, {
      fallbackModels: ['backup-a'],
      forceCompact: () => Promise.resolve(false),
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('error');
    expect(provider.requests).toHaveLength(1);
    expect(events.some((e) => e.type === 'model-fallback')).toBe(false);
  });
});
