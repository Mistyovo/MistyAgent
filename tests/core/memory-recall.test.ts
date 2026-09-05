import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findRelevantMemories } from '#/core/memory/recall';
import type { UserMessage } from '#/provider/types';

import { FakeProvider, textStep } from './fake-provider';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'misty-mem-recall-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeMemory = (filename: string, description: string, body: string): Promise<void> =>
  writeFile(
    path.join(dir, filename),
    `---\nname: ${filename}\ndescription: ${description}\ntype: user\n---\n\n${body}\n`,
    'utf8',
  );

describe('findRelevantMemories', () => {
  it('空目录直接返回 []，不请求 provider', async () => {
    const provider = new FakeProvider([]);
    const result = await findRelevantMemories({
      provider,
      model: 'fake-model',
      query: '用户的偏好',
      dir,
    });
    expect(result).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });

  it('选中记忆后读入文件内容', async () => {
    await writeMemory('a.md', '用户是数据科学家', '用户目前关注日志与可观测性。');
    await writeMemory('b.md', '项目发布冻结', '周五起冻结合并。');
    const provider = new FakeProvider([textStep('{"selected": ["a.md"]}')]);

    const result = await findRelevantMemories({
      provider,
      model: 'fake-model',
      query: '用户在排查日志',
      dir,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(path.join(dir, 'a.md'));
    expect(result[0]!.content).toContain('用户目前关注日志与可观测性。');
    expect(result[0]!.mtimeMs).toBeGreaterThan(0);
    expect(provider.requests[0]!.maxTokens).toBe(256);
    expect(provider.requests[0]!.tools).toEqual([]);
  });

  it('非法输出容错为 []', async () => {
    await writeMemory('a.md', '用户是数据科学家', '正文');
    const provider = new FakeProvider([textStep('这不是 JSON')]);
    const result = await findRelevantMemories({
      provider,
      model: 'fake-model',
      query: '任意',
      dir,
    });
    expect(result).toEqual([]);
  });

  it('选中清单外的文件名被过滤', async () => {
    await writeMemory('a.md', '用户是数据科学家', '正文');
    const provider = new FakeProvider([textStep('{"selected": ["ghost.md"]}')]);
    const result = await findRelevantMemories({
      provider,
      model: 'fake-model',
      query: '任意',
      dir,
    });
    expect(result).toEqual([]);
  });

  it('provider 出错返回 [] 而不抛错', async () => {
    await writeMemory('a.md', '用户是数据科学家', '正文');
    const provider = new FakeProvider([[{ type: 'error', error: new Error('boom') }]]);
    const result = await findRelevantMemories({
      provider,
      model: 'fake-model',
      query: '任意',
      dir,
    });
    expect(result).toEqual([]);
  });

  it('alreadySurfaced 在选取前过滤，全部过滤则不再请求', async () => {
    await writeMemory('a.md', '用户是数据科学家', '正文');
    const provider = new FakeProvider([]);
    const result = await findRelevantMemories({
      provider,
      model: 'fake-model',
      query: '任意',
      dir,
      alreadySurfaced: new Set([path.join(dir, 'a.md')]),
    });
    expect(result).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });

  it('alreadySurfaced 的候选不进清单，选中它也不算数', async () => {
    await writeMemory('a.md', '用户是数据科学家', '正文');
    await writeMemory('b.md', '项目发布冻结', '正文');
    const provider = new FakeProvider([textStep('{"selected": ["a.md"]}')]);

    const result = await findRelevantMemories({
      provider,
      model: 'fake-model',
      query: '任意',
      dir,
      alreadySurfaced: new Set([path.join(dir, 'a.md')]),
    });

    expect(result).toEqual([]);
    const prompt = (provider.requests[0]!.messages[0] as UserMessage).content;
    expect(prompt).toContain('b.md');
    expect(prompt).not.toContain('a.md');
  });
});
