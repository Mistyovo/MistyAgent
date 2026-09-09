import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemoryExtraction } from '#/core/memory/extract';
import type { Message } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

let dir: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'misty-mem-extract-'));
  cwd = await mkdtemp(path.join(tmpdir(), 'misty-mem-cwd-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const transcript: Message[] = [
  { role: 'user', content: '我是数据科学家，主要用 Python，目前在排查日志相关的需求。' },
  { role: 'assistant', content: '好的，我先看一下日志模块。' },
];

const USER_MEMORY = [
  '---',
  'name: 用户角色',
  'description: 用户是数据科学家，主要用 Python',
  'type: user',
  '---',
  '',
  '用户是数据科学家，主要用 Python，目前关注日志与可观测性。',
  '',
].join('\n');

describe('runMemoryExtraction', () => {
  it('提取代理写入记忆并体现在 written 清单', async () => {
    const topicFile = path.join(dir, 'user_role.md');
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'write', arguments: JSON.stringify({ path: topicFile, content: USER_MEMORY }) },
        {
          name: 'write',
          arguments: JSON.stringify({
            path: path.join(dir, 'MEMORY.md'),
            content: '- [用户角色](user_role.md) — 用户是数据科学家\n',
          }),
        },
      ]),
      textStep('提取完成'),
    ]);

    const result = await runMemoryExtraction({
      provider,
      model: 'fake-model',
      messages: transcript,
      cwd,
      dir,
    });

    expect(result.written).toEqual([topicFile]);
    expect(await readFile(topicFile, 'utf8')).toBe(USER_MEMORY);
    expect(existsSync(path.join(dir, 'MEMORY.md'))).toBe(true);
    expect(provider.requests[0]!.systemPrompt).toContain('memory extraction subagent');
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual([
      'read',
      'glob',
      'grep',
      'write',
      'edit',
    ]);
  });

  it('目录外的写入被拒绝，文件不落盘', async () => {
    const outside = path.join(cwd, 'evil.md');
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'write', arguments: JSON.stringify({ path: outside, content: '越界写入' }) },
      ]),
      textStep('已放弃'),
    ]);

    const result = await runMemoryExtraction({
      provider,
      model: 'fake-model',
      messages: transcript,
      cwd,
      dir,
    });

    expect(result).toEqual({ written: [] });
    expect(existsSync(outside)).toBe(false);
    const secondStepMessages = provider.requests[1]!.messages;
    expect(
      secondStepMessages.some(
        (m) => m.role === 'tool' && m.isError === true && m.content.includes('memory directory'),
      ),
    ).toBe(true);
  });

  it('模型判断无值得保存的内容时不写文件', async () => {
    const provider = new FakeProvider([textStep('没有值得保存的内容。')]);
    const result = await runMemoryExtraction({
      provider,
      model: 'fake-model',
      messages: transcript,
      cwd,
      dir,
    });
    expect(result).toEqual({ written: [] });
    expect(existsSync(path.join(dir, 'MEMORY.md'))).toBe(false);
  });

  it('provider 出错返回空清单而不抛错', async () => {
    const provider = new FakeProvider([[{ type: 'error', error: new Error('boom') }]]);
    const result = await runMemoryExtraction({
      provider,
      model: 'fake-model',
      messages: transcript,
      cwd,
      dir,
    });
    expect(result).toEqual({ written: [] });
  });

  it('空对话不跑提取', async () => {
    const provider = new FakeProvider([]);
    const result = await runMemoryExtraction({
      provider,
      model: 'fake-model',
      messages: [],
      cwd,
      dir,
    });
    expect(result).toEqual({ written: [] });
    expect(provider.requests).toHaveLength(0);
  });
});
