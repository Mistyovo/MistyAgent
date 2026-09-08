import { describe, expect, it } from 'vitest';

import { lookupModelContextWindow } from '#/provider/model-registry';

describe('lookupModelContextWindow', () => {
  it('精确与带后缀的模型名都能按前缀命中', () => {
    expect(lookupModelContextWindow('gpt-5-mini')).toBe(400_000);
    expect(lookupModelContextWindow('GPT-4o-2024-08-13')).toBe(128_000);
    expect(lookupModelContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(lookupModelContextWindow('kimi-k2-0711-preview')).toBe(256_000);
  });

  it('取最长命中前缀：gpt-4.1 优先于 gpt-4', () => {
    expect(lookupModelContextWindow('gpt-4.1-mini')).toBe(1_000_000);
  });

  it('未收录模型返回 null（回落默认 100k）', () => {
    expect(lookupModelContextWindow('some-unknown-model')).toBeNull();
    expect(lookupModelContextWindow('')).toBeNull();
  });
});
