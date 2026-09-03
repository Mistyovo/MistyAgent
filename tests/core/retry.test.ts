import { describe, expect, it } from 'vitest';

import { chatWithRetry } from '#/core/loop/retry';
import type { ChatParams, ChatProvider, StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep } from './fake-provider';

const params: ChatParams = {
  model: 'fake-model',
  systemPrompt: 'system',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
};

const noSleep = (): Promise<void> => Promise.resolve();

async function collect(provider: ChatProvider): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of chatWithRetry(provider, params, { sleep: noSleep })) {
    parts.push(part);
  }
  return parts;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** 返回一个 next() 直接 reject 的 AsyncIterable，模拟 generate 抛异常 */
function throwingStream(error: Error): AsyncIterable<StreamedMessagePart> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
    }),
  };
}

describe('chatWithRetry', () => {
  it('429 错误退避后重试成功', async () => {
    const provider = new FakeProvider([
      [{ type: 'error', error: httpError(429, 'rate limited') }],
      textStep('ok'),
    ]);

    const parts = await collect(provider);

    expect(provider.requests).toHaveLength(2);
    expect(parts.map((p) => p.type)).toEqual(['text-delta', 'done']);
  });

  it('持续 5xx 在 1+3 次尝试后透传 error part', async () => {
    const provider = new FakeProvider([
      [{ type: 'error', error: httpError(500, 'server boom') }],
      [{ type: 'error', error: httpError(500, 'server boom') }],
      [{ type: 'error', error: httpError(500, 'server boom') }],
      [{ type: 'error', error: httpError(500, 'server boom') }],
    ]);

    const parts = await collect(provider);

    expect(provider.requests).toHaveLength(4);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'error' });
  });

  it('400 不可重试，直接透传', async () => {
    const provider = new FakeProvider([
      [{ type: 'error', error: httpError(400, 'bad request') }],
    ]);

    const parts = await collect(provider);

    expect(provider.requests).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'error' });
  });

  it('已流出内容后出错不再重试', async () => {
    const provider = new FakeProvider([
      [
        { type: 'text-delta', text: 'partial' },
        { type: 'error', error: httpError(500, 'mid-stream boom') },
      ],
      textStep('must-not-be-used'),
    ]);

    const parts = await collect(provider);

    expect(provider.requests).toHaveLength(1);
    expect(parts.map((p) => p.type)).toEqual(['text-delta', 'error']);
  });

  it('provider 抛出的网络异常同样重试', async () => {
    let calls = 0;
    const provider: ChatProvider = {
      generate: () => {
        calls += 1;
        if (calls === 1) {
          return throwingStream(new TypeError('fetch failed'));
        }
        return new FakeProvider([textStep('recovered')]).generate(params);
      },
    };

    const parts = await collect(provider);

    expect(calls).toBe(2);
    expect(parts.map((p) => p.type)).toEqual(['text-delta', 'done']);
  });

  it('非网络异常（编程错误）不重试，规整为 error part', async () => {
    const provider: ChatProvider = {
      generate: () => throwingStream(new Error('undefined is not a function')),
    };

    const parts = await collect(provider);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'error' });
  });
});
