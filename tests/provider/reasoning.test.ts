import { describe, expect, it } from 'vitest';

import { extractReasoning } from '#/provider/openai/reasoning';

import { collectParts } from './fake-chunks';

describe('extractReasoning', () => {
  it('非对象输入返回 undefined', () => {
    expect(extractReasoning(null)).toBeUndefined();
    expect(extractReasoning('reasoning_content')).toBeUndefined();
    expect(extractReasoning(42)).toBeUndefined();
  });

  it('按优先级探测 reasoning_content → reasoning', () => {
    expect(extractReasoning({ reasoning_content: 'a' })).toEqual({
      key: 'reasoning_content',
      value: 'a',
    });
    expect(extractReasoning({ reasoning: 'b' })).toEqual({ key: 'reasoning', value: 'b' });
    expect(extractReasoning({ reasoning: 'b', reasoning_content: 'a' })).toEqual({
      key: 'reasoning_content',
      value: 'a',
    });
  });

  it('非字符串值被跳过', () => {
    expect(extractReasoning({ reasoning_content: null, reasoning: 'x' })).toEqual({
      key: 'reasoning',
      value: 'x',
    });
    expect(extractReasoning({ reasoning_content: ['array-shaped'] })).toBeUndefined();
  });

  it('explicitKey 钉死字段名，禁用探测', () => {
    expect(extractReasoning({ custom_think: 'c', reasoning_content: 'a' }, 'custom_think')).toEqual({
      key: 'custom_think',
      value: 'c',
    });
    expect(extractReasoning({ reasoning_content: 'a' }, 'custom_think')).toBeUndefined();
  });
});

describe('流中的 reasoning delta', () => {
  it('reasoning_content 字段产出 reasoning-delta', async () => {
    const parts = await collectParts([
      { delta: { reasoning_content: '让我想想，' } },
      { delta: { reasoning_content: '答案是 42' } },
      { delta: { content: '42' }, finishReason: 'stop' },
    ]);

    expect(parts).toEqual([
      { type: 'reasoning-delta', text: '让我想想，' },
      { type: 'reasoning-delta', text: '答案是 42' },
      { type: 'text-delta', text: '42' },
      {
        type: 'done',
        usage: null,
        finishReason: 'completed',
        rawFinishReason: 'stop',
      },
    ]);
  });

  it('reasoning 字段方言同样被识别，空字符串不产出 part', async () => {
    const parts = await collectParts([
      { delta: { reasoning: 'thinking' } },
      { delta: { reasoning: '' } },
      { delta: {}, finishReason: 'stop' },
    ]);

    expect(parts[0]).toEqual({ type: 'reasoning-delta', text: 'thinking' });
    expect(parts).toHaveLength(2);
  });

  it('reasoningKey 选项钉死探测字段', async () => {
    const parts = await collectParts(
      [
        { delta: { reasoning_content: '被忽略', custom: '生效' } },
        { delta: {}, finishReason: 'stop' },
      ],
      { reasoningKey: 'custom' },
    );

    expect(parts[0]).toEqual({ type: 'reasoning-delta', text: '生效' });
  });
});
