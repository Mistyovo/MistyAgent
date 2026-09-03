import { describe, expect, it } from 'vitest';

import {
  compactHistory,
  estimateTokens,
  maybeCompactHistory,
} from '#/core/context/compact';
import type { Message } from '#/provider/types';

import { FakeProvider, textStep } from './fake-provider';

function makeMessages(pairs: number, contentLength = 40): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < pairs; index += 1) {
    messages.push({ role: 'user', content: `q${index}:${'x'.repeat(contentLength)}` });
    messages.push({ role: 'assistant', content: `a${index}:${'y'.repeat(contentLength)}` });
  }
  return messages;
}

describe('estimateTokens', () => {
  it('每条消息固定开销 + 字符数 / 4', () => {
    const messages: Message[] = [
      { role: 'user', content: 'x'.repeat(40) },
      {
        role: 'assistant',
        content: 'y'.repeat(40),
        reasoning: 'r'.repeat(8),
        toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"echo 1"}' }],
      },
    ];
    // user: 4 + 10；assistant: 4 + ceil((40+8+4+21)/4)
    const expected = 4 + 10 + (4 + Math.ceil((40 + 8 + 4 + '{"command":"echo 1"}'.length) / 4));
    expect(estimateTokens(messages)).toBe(expected);
  });
});

describe('maybeCompactHistory', () => {
  it('低于阈值不触发（不消耗 provider 调用）', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    const messages = makeMessages(3);

    const result = await maybeCompactHistory({
      provider,
      model: 'fake',
      messages,
      maxContextTokens: 100_000,
    });

    expect(result).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  it('超过阈值触发：摘要 + 最近 4 条重建历史', async () => {
    const provider = new FakeProvider([textStep('这是摘要')]);
    const messages = makeMessages(6);

    const result = await maybeCompactHistory({
      provider,
      model: 'fake',
      messages,
      maxContextTokens: 10,
    });

    expect(result).not.toBeNull();
    expect(result!.beforeCount).toBe(12);
    expect(result!.afterCount).toBe(5);
    expect(provider.requests).toHaveLength(1);
    // 摘要请求：原历史 + 摘要 prompt
    expect(provider.requests[0]!.messages).toHaveLength(13);
    expect(provider.requests[0]!.tools).toEqual([]);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toEqual({ role: 'user', content: '[历史对话摘要]\n这是摘要' });
    expect(messages.slice(1)).toEqual(makeMessages(6).slice(-4));
  });

  it('保留窗口以 tool 消息开头时丢弃，避免悬空 tool_result', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    const messages: Message[] = [
      ...makeMessages(3),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'out' },
      { role: 'user', content: 'tail-q' },
    ];

    const result = await compactHistory({ provider, model: 'fake', messages, keepRecent: 2 });

    expect(result).not.toBeNull();
    expect(messages.map((message) => message.role)).toEqual(['user', 'user']);
    expect(messages[1]).toEqual({ role: 'user', content: 'tail-q' });
  });

  it('摘要生成失败（error part）时原样继续', async () => {
    const provider = new FakeProvider([[{ type: 'error', error: new Error('boom') }]]);
    const messages = makeMessages(6);
    const snapshot = structuredClone(messages);

    const result = await maybeCompactHistory({
      provider,
      model: 'fake',
      messages,
      maxContextTokens: 10,
    });

    expect(result).toBeNull();
    expect(messages).toEqual(snapshot);
  });

  it('generate 抛异常时原样继续', async () => {
    const provider = new FakeProvider([]);
    const messages = makeMessages(6);
    const snapshot = structuredClone(messages);

    const result = await compactHistory({ provider, model: 'fake', messages });

    // FakeProvider 没有预设响应时流以 error part 结束，等价于失败
    expect(result).toBeNull();
    expect(messages).toEqual(snapshot);
  });

  it('历史不超过 keepRecent 条时不压缩', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    const messages = makeMessages(2);

    const result = await compactHistory({ provider, model: 'fake', messages });

    expect(result).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });
});
