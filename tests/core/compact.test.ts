import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compactHistory,
  estimateTokens,
  extractRecentReadFiles,
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
  it('每条消息固定开销 + 分段估算（ASCII 4 字符/token，reasoning 不计入）', () => {
    const messages: Message[] = [
      { role: 'user', content: 'x'.repeat(40) },
      {
        role: 'assistant',
        content: 'y'.repeat(40),
        reasoning: 'r'.repeat(8),
        toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"echo 1"}' }],
      },
    ];
    // user: 4 + 40/4；assistant: 4 + 40/4 + 4/4 + ceil(21/4)；reasoning 不回传 API 不计入
    const expected =
      4 + 10 + (4 + 10 + Math.ceil(4 / 4) + Math.ceil('{"command":"echo 1"}'.length / 4));
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
      maxContextTokens: 200,
    });

    expect(result).not.toBeNull();
    expect(result!.beforeCount).toBe(12);
    expect(result!.afterCount).toBe(5);
    expect(provider.requests).toHaveLength(1);
    // 摘要请求按预算截窗（每条 15 token，预算 100 → 尾部 6 条）：省略概况 + 窗口 + prompt
    expect(provider.requests[0]!.messages).toHaveLength(8);
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

  it('force: true 无视阈值强制压缩', async () => {
    const provider = new FakeProvider([textStep('摘要')]);
    const messages = makeMessages(6);

    const result = await maybeCompactHistory({
      provider,
      model: 'fake',
      messages,
      maxContextTokens: 100_000,
      force: true,
    });

    expect(result).not.toBeNull();
    expect(provider.requests).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: '[历史对话摘要]\n摘要' });
  });
});

function readCall(id: string, filePath: string): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'read', arguments: JSON.stringify({ path: filePath }) }],
  };
}

function readResult(id: string, content: string, isError = false): Message {
  const message: Message = { role: 'tool', toolCallId: id, name: 'read', content };
  if (isError) {
    (message as { isError?: boolean }).isError = true;
  }
  return message;
}

describe('extractRecentReadFiles', () => {
  it('从 assistant toolCalls 提取 read 路径：最新在前、去重、忽略其他工具', () => {
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'c2', name: 'write', arguments: '{"path":"w.ts"}' },
        ],
      },
      readResult('c1', '...'),
      readCall('c3', 'b.ts'),
      readResult('c3', '...'),
      readCall('c4', 'a.ts'),
      readResult('c4', '...'),
    ];

    expect(extractRecentReadFiles(messages)).toEqual(['a.ts', 'b.ts']);
  });

  it('跳过 isError 的读取与残缺 arguments；封顶 maxFiles', () => {
    const messages: Message[] = [
      readCall('c1', 'gone.ts'),
      readResult('c1', '文件不存在', true),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: '{oops' }] },
      readResult('c2', '...'),
      readCall('c3', 'ok.ts'),
      readResult('c3', '...'),
    ];

    expect(extractRecentReadFiles(messages)).toEqual(['ok.ts']);
  });

  it('默认封顶 5 个，可传 maxFiles 收紧', () => {
    const messages: Message[] = [];
    for (let index = 0; index < 6; index += 1) {
      messages.push(readCall(`c${index}`, `f${index}.ts`));
      messages.push(readResult(`c${index}`, '...'));
    }

    expect(extractRecentReadFiles(messages)).toEqual([
      'f5.ts',
      'f4.ts',
      'f3.ts',
      'f2.ts',
      'f1.ts',
    ]);
    expect(extractRecentReadFiles(messages, 2)).toEqual(['f5.ts', 'f4.ts']);
  });
});

describe('压缩后回注最近读过的文件', () => {
  it('压缩后历史包含文件当前内容的 user 消息（按时间序，摘要之后）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'misty-compact-'));
    await writeFile(path.join(dir, 'alpha.ts'), 'const alpha = 1;\n', 'utf8');
    await writeFile(path.join(dir, 'beta.ts'), 'const beta = 2;\n', 'utf8');
    const messages: Message[] = [
      ...makeMessages(3),
      readCall('r1', 'alpha.ts'),
      readResult('r1', '旧的 alpha 内容'),
      readCall('r2', 'beta.ts'),
      readResult('r2', '旧的 beta 内容'),
      { role: 'user', content: 'tail question' },
    ];
    const provider = new FakeProvider([textStep('摘要')]);

    const result = await compactHistory({ provider, model: 'fake', messages, cwd: dir });

    expect(result).not.toBeNull();
    expect(messages[0]).toEqual({ role: 'user', content: '[历史对话摘要]\n摘要' });
    // 回注消息在摘要之后、保留尾部之前，按读取先后排列
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('alpha.ts');
    expect(messages[1]!.content).toContain('const alpha = 1;');
    expect(messages[1]!.content).not.toContain('旧的 alpha 内容');
    expect(messages[2]!.content).toContain('beta.ts');
    expect(messages[2]!.content).toContain('const beta = 2;');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'tail question' });
  });

  it('文件已删除则跳过该文件的回注', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'misty-compact-'));
    await writeFile(path.join(dir, 'kept.ts'), 'const kept = 1;\n', 'utf8');
    const messages: Message[] = [
      ...makeMessages(3),
      readCall('r1', 'deleted.ts'),
      readResult('r1', '当时还在的内容'),
      readCall('r2', 'kept.ts'),
      readResult('r2', '...'),
      { role: 'user', content: 'tail' },
    ];
    const provider = new FakeProvider([textStep('摘要')]);

    const result = await compactHistory({ provider, model: 'fake', messages, cwd: dir });

    expect(result).not.toBeNull();
    const reinjected = messages.filter(
      (m) => m.role === 'user' && m.content.includes('重新加载当前内容'),
    );
    expect(reinjected).toHaveLength(1);
    expect(reinjected[0]!.content).toContain('kept.ts');
    expect(messages.some((m) => m.content.includes('deleted.ts'))).toBe(false);
  });

  it('回注总大小超预算时丢弃更旧的文件', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'misty-compact-'));
    // 每个文件约 8KB（80 行 × 100 字符 + 行号）
    const body = `${'x'.repeat(100)}\n`.repeat(80);
    await writeFile(path.join(dir, 'f1.txt'), body, 'utf8');
    await writeFile(path.join(dir, 'f2.txt'), body, 'utf8');
    await writeFile(path.join(dir, 'f3.txt'), body, 'utf8');
    const messages: Message[] = [
      ...makeMessages(3),
      readCall('r1', 'f1.txt'),
      readResult('r1', '...'),
      readCall('r2', 'f2.txt'),
      readResult('r2', '...'),
      readCall('r3', 'f3.txt'),
      readResult('r3', '...'),
      { role: 'user', content: 'tail' },
    ];
    const provider = new FakeProvider([textStep('摘要')]);

    const result = await compactHistory({ provider, model: 'fake', messages, cwd: dir });

    expect(result).not.toBeNull();
    const reinjected = messages.filter(
      (m) => m.role === 'user' && m.content.includes('重新加载当前内容'),
    );
    // 预算 20KB：保留最新的 f3、f2，丢弃最旧的 f1
    expect(reinjected).toHaveLength(2);
    expect(reinjected[0]!.content).toContain('f2.txt');
    expect(reinjected[1]!.content).toContain('f3.txt');
    const total = reinjected.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(20_000 + 200);
  });

  it('单个文件即超预算时截断该文件并标注', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'misty-compact-'));
    const body = `${'y'.repeat(100)}\n`.repeat(300); // ≈31KB
    await writeFile(path.join(dir, 'big.txt'), body, 'utf8');
    const messages: Message[] = [
      ...makeMessages(3),
      readCall('r1', 'big.txt'),
      readResult('r1', '...'),
      { role: 'user', content: 'tail' },
    ];
    const provider = new FakeProvider([textStep('摘要')]);

    const result = await compactHistory({ provider, model: 'fake', messages, cwd: dir });

    expect(result).not.toBeNull();
    const reinjected = messages.filter(
      (m) => m.role === 'user' && m.content.includes('重新加载当前内容'),
    );
    expect(reinjected).toHaveLength(1);
    expect(reinjected[0]!.content.length).toBeLessThanOrEqual(21_000);
    expect(reinjected[0]!.content).toContain('截断');
  });

  it('不提供 cwd 时不回注（保持原行为）', async () => {
    const messages: Message[] = [
      ...makeMessages(3),
      readCall('r1', 'a.ts'),
      readResult('r1', '...'),
      { role: 'user', content: 'tail' },
    ];
    const provider = new FakeProvider([textStep('摘要')]);

    const result = await compactHistory({ provider, model: 'fake', messages });

    expect(result).not.toBeNull();
    expect(messages.some((m) => m.content.includes('重新加载当前内容'))).toBe(false);
  });
});
