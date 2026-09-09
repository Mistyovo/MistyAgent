import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '#/provider/types';

import {
  estimateTokens,
  isOverCompactThreshold,
  pruneStaleToolOutputs,
} from '#/core/context/compact';
import { spillToolOutput } from '#/core/output-spill';

function toolMessage(content: string): Message {
  return { role: 'tool', toolCallId: `t-${Math.random().toString(36).slice(2)}`, name: 'read', content };
}

describe('pruneStaleToolOutputs 微压缩', () => {
  let spillDir: string;

  beforeEach(() => {
    spillDir = mkdtempSync(path.join(tmpdir(), 'misty-prune-spill-'));
    process.env.MISTY_OUTPUT_DIR = spillDir;
  });

  afterEach(() => {
    delete process.env.MISTY_OUTPUT_DIR;
    rmSync(spillDir, { recursive: true, force: true });
  });

  it('只修剪保护窗口外的超长 tool 输出，保留最近消息与非 tool 消息', () => {
    const big = 'x'.repeat(5000);
    const messages: Message[] = [
      { role: 'user', content: 'hi' }, // 0
      toolMessage(big), // 1：会被修剪
      { role: 'assistant', content: 'done' }, // 2
      toolMessage(big), // 3：会被修剪
      toolMessage('short'), // 4：太短，不修剪
      ...Array.from({ length: 12 }, () => toolMessage(big) as Message), // 尾部 12 条受保护
    ];
    const before = estimateTokens(messages);
    const result = pruneStaleToolOutputs(messages);

    expect(result).not.toBeNull();
    expect(result!.prunedCount).toBe(2);
    expect(result!.afterTokens).toBeLessThan(before);
    expect((messages[1] as { content: string }).content).toContain('pruned');
    expect((messages[2] as { content: string }).content).toBe('done');
    expect((messages[3] as { content: string }).content).toContain('pruned');
    expect((messages[4] as { content: string }).content).toBe('short');
    for (const message of messages.slice(-12)) {
      expect(message.content).not.toContain('pruned');
    }
  });

  it('幂等：修剪后的占位符不会被二次修剪', () => {
    const messages: Message[] = [toolMessage('y'.repeat(4000)), ...Array.from({ length: 12 }, () => toolMessage('tail') as Message)];
    expect(pruneStaleToolOutputs(messages)!.prunedCount).toBe(1);
    expect(pruneStaleToolOutputs(messages)).toBeNull();
  });

  it('没有可修剪目标时返回 null', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      toolMessage('short'),
      { role: 'assistant', content: 'ok' },
    ];
    expect(pruneStaleToolOutputs(messages)).toBeNull();
  });

  it('spill 把全量输出落盘并在占位符附路径', () => {
    const big = `${'line\n'.repeat(1000)}`;
    const messages: Message[] = [
      toolMessage(big),
      ...Array.from({ length: 12 }, () => toolMessage('tail') as Message),
    ];
    const result = pruneStaleToolOutputs(messages, {
      spill: (output) => spillToolOutput(output, 'prune-test'),
    });
    expect(result!.prunedCount).toBe(1);
    const placeholder = (messages[0] as { content: string }).content;
    expect(placeholder).toContain('the full output is on disk at');
    const match = /the full output is on disk at (.+)]$/.exec(placeholder);
    expect(match).not.toBeNull();
    expect(readFileSync(match![1]!, 'utf8')).toBe(big);
  });

  it('isOverCompactThreshold 按阈值判定', () => {
    const big: Message = { role: 'user', content: 'a'.repeat(4 * 90_000) };
    expect(isOverCompactThreshold([big], 100_000)).toBe(true);
    expect(isOverCompactThreshold([{ role: 'user', content: 'tiny' }], 100_000)).toBe(false);
  });
});
