import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckpointStore } from '#/core/checkpoint/checkpoint';
import { withCheckpoint } from '#/core/checkpoint/wrap';
import { Session } from '#/core/session/session';
import { writeTool } from '#/core/tools/builtin/write';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'misty-session-checkpoint-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore(): CheckpointStore {
  return new CheckpointStore(dir, { dir: join(dir, '.checkpoints') });
}

function makeSession(provider: FakeProvider, store: CheckpointStore): Session {
  return new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: [withCheckpoint(writeTool, store)],
    cwd: dir,
    permission: { mode: 'bypassPermissions' },
    checkpoints: store,
  });
}

describe('Session 检查点接线', () => {
  it('turn 内 write 后 list() 有记录，rewind 后文件内容还原', async () => {
    const target = join(dir, 'target.txt');
    await writeFile(target, '原始内容', 'utf8');
    const store = makeStore();
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'write', arguments: JSON.stringify({ path: 'target.txt', content: '新内容' }) },
      ]),
      textStep('完成'),
    ]);
    const session = makeSession(provider, store);

    const result = await session.submit({ type: 'user-turn', text: '改一下文件' });

    expect(result.stopReason).toBe('completed');
    expect(await readFile(target, 'utf8')).toBe('新内容');
    const checkpoints = store.list();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.userText).toBe('改一下文件');
    expect(checkpoints[0]!.files.map((file) => file.path)).toEqual([target]);

    const rewound = store.rewind(checkpoints[0]!.id);
    expect(rewound).toMatchObject({ restored: [target], deleted: [] });
    expect(await readFile(target, 'utf8')).toBe('原始内容');
  });

  it('newSession 后检查点清单清空', async () => {
    const store = makeStore();
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'write', arguments: JSON.stringify({ path: 'a.txt', content: '内容' }) },
      ]),
      textStep('完成'),
    ]);
    const session = makeSession(provider, store);

    await session.submit({ type: 'user-turn', text: '建个文件' });
    // endTurn 在 submit resolve 之后的 finally 里密封检查点
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    session.newSession();
    expect(store.list()).toHaveLength(0);
  });
});
