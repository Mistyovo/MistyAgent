import { describe, expect, it } from 'vitest';

import { compactHistory, estimateTokens, maybeCompactHistory } from '#/core/context/compact';
import type { Message } from '#/provider/types';

import { FakeProvider, textStep } from './fake-provider';

function bigUserMessage(index: number, chars: number): Message {
  return { role: 'user', content: `q${index}:${'x'.repeat(chars)}` };
}

describe('estimateTokens 分段估算', () => {
  it('CJK 按 1 字符 ≈ 1 token 计入', () => {
    expect(estimateTokens([{ role: 'user', content: '你好世界' }])).toBe(4 + 4);
  });

  it('ASCII 与 CJK 混合分段估算；代理对按 1 个码点计', () => {
    // '你好'(2 CJK) + 8 ASCII → 2 + ceil(8/4) = 4
    expect(estimateTokens([{ role: 'user', content: '你好abcdefgh' }])).toBe(4 + 4);
    // '𠮷' 占 2 个 UTF-16 码元但是 1 个码点：1 wide + ceil(2/4)
    expect(estimateTokens([{ role: 'user', content: 'ab𠮷' }])).toBe(4 + 1 + 1);
  });

  it('reasoning 不回传 API，不计入估算', () => {
    const withReasoning: Message = {
      role: 'assistant',
      content: '回答',
      reasoning: 'r'.repeat(10_000),
    };
    const withoutReasoning: Message = { role: 'assistant', content: '回答' };
    expect(estimateTokens([withReasoning])).toBe(estimateTokens([withoutReasoning]));
    expect(estimateTokens([withoutReasoning])).toBe(4 + 2);
  });
});

describe('摘要请求截窗（历史硬超上下文时）', () => {
  it('只送尾部窗口 + 省略概况，摘要请求自身不超 maxContextTokens', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    // 40 条 × 约 505 token ≈ 20K token，远超 maxContextTokens
    const messages: Message[] = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push(bigUserMessage(index, 2_000));
    }
    const original = structuredClone(messages);
    const maxContextTokens = 10_000;

    const result = await maybeCompactHistory({
      provider,
      model: 'fake',
      messages,
      maxContextTokens,
    });

    expect(result).not.toBeNull();
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!.messages;
    // 请求 = 省略概况 + 尾部窗口 + 摘要 prompt，整体估算不超限
    expect(estimateTokens(request)).toBeLessThanOrEqual(maxContextTokens);
    expect(request[0]!.content).toContain('省略');
    expect(request.at(-1)!.content).toContain('摘要');
    // 窗口是原历史的尾部切片，且窗口本身在摘要预算内
    const windowMessages = request.slice(1, -1);
    expect(windowMessages.length).toBeGreaterThan(0);
    expect(windowMessages.length).toBeLessThan(original.length);
    expect(estimateTokens(windowMessages)).toBeLessThanOrEqual(maxContextTokens / 2);
    expect(windowMessages).toEqual(original.slice(original.length - windowMessages.length));
    // 压缩重建照常：摘要开头 + 保留尾部
    expect(messages[0]).toEqual({ role: 'user', content: '[历史对话摘要]\n摘要' });
    expect(result!.beforeCount).toBe(40);
  });

  it('窗口开头为 tool 消息时连同丢弃，保持 wire 配对合法', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    const messages: Message[] = [
      bigUserMessage(0, 1_000),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'bash', content: 'ok' },
      { role: 'user', content: 'tail' },
    ];

    // 预算 12：tail(5) + tool(5) 可入窗，assistant(6) 超出 → 窗口起于 tool，须丢弃
    const result = await compactHistory({
      provider,
      model: 'fake',
      messages,
      keepRecent: 2,
      maxContextTokens: 24,
    });

    expect(result).not.toBeNull();
    const request = provider.requests[0]!.messages;
    expect(request.some((message) => message.role === 'tool')).toBe(false);
    expect(request).toHaveLength(3);
    expect(request[0]!.content).toContain('省略');
    expect(request[1]).toEqual({ role: 'user', content: 'tail' });
    expect(request[2]!.content).toContain('摘要');
    // 重建尾部同样丢弃悬空 tool 消息
    expect(messages.map((message) => message.role)).toEqual(['user', 'user']);
  });

  it('省略概况列出被丢弃部分的工具调用次数与最近 read 文件', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    const messages: Message[] = [
      bigUserMessage(0, 800),
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{"path":"src/a.ts"}' },
          { id: 'c2', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
      { role: 'tool', toolCallId: 'c1', name: 'read', content: 'a 内容' },
      { role: 'tool', toolCallId: 'c2', name: 'bash', content: 'b 内容' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c3', name: 'bash', arguments: '{"command":"pwd"}' }],
      },
      { role: 'tool', toolCallId: 'c3', name: 'bash', content: 'c 内容' },
      bigUserMessage(4, 10),
      bigUserMessage(5, 10),
    ];

    // 预算 20：仅尾部两条 user(8+8) 入窗，前 6 条进省略概况
    const result = await compactHistory({
      provider,
      model: 'fake',
      messages,
      maxContextTokens: 40,
    });

    expect(result).not.toBeNull();
    const request = provider.requests[0]!.messages;
    expect(request).toHaveLength(4);
    const digest = request[0]!;
    expect(digest.role).toBe('user');
    expect(digest.content).toContain('更早的 6 条');
    expect(digest.content).toContain('read×1');
    expect(digest.content).toContain('bash×2');
    expect(digest.content).toContain('src/a.ts');
  });

  it('force 压缩硬超上下文的历史：摘要请求不超限且压缩成功', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    // 单条消息即超摘要预算的极端历史（每条 6000 CJK 字符 ≈ 6000 token）
    const messages: Message[] = [];
    for (let index = 0; index < 6; index += 1) {
      messages.push({ role: 'user', content: `第${index}条：${'汉'.repeat(6_000)}` });
    }
    const maxContextTokens = 4_000;

    const result = await maybeCompactHistory({
      provider,
      model: 'fake',
      messages,
      maxContextTokens,
      force: true,
    });

    expect(result).not.toBeNull();
    const request = provider.requests[0]!.messages;
    // 窗口退化为空：仅省略概况 + 摘要 prompt，请求自身不超限
    expect(request).toHaveLength(2);
    expect(estimateTokens(request)).toBeLessThanOrEqual(maxContextTokens);
    expect(result!.beforeCount).toBe(6);
    expect(messages[0]!.content).toContain('[历史对话摘要]');
  });
});
