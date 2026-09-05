import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '#/core/checkpoint/checkpoint';
import { withCheckpoint } from '#/core/checkpoint/wrap';
import { readTool } from '#/core/tools/builtin/read';
import { writeTool } from '#/core/tools/builtin/write';
import type { ToolContext } from '#/core/tools/tool';

describe('withCheckpoint：写类工具写前快照', () => {
  let cwd: string;
  let dir: string;
  let store: CheckpointStore;
  let ctx: ToolContext;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'misty-wrap-cwd-'));
    dir = mkdtempSync(join(tmpdir(), 'misty-wrap-store-'));
    store = new CheckpointStore(cwd, { dir });
    ctx = { cwd, signal: new AbortController().signal };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('write 调用前备份原文件，相对路径按 store.cwd resolve', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'old');
    const wrapped = withCheckpoint(writeTool, store);
    store.beginTurn('改 a.txt');

    const result = await wrapped.call({ path: 'a.txt', content: 'new' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('new');

    store.endTurn();
    const record = store.list()[0]!.files[0]!;
    expect(record.path).toBe(join(cwd, 'a.txt'));
    expect(record.existed).toBe(true);
    expect(readFileSync(record.backupPath, 'utf8')).toBe('old');
  });

  it('同 turn 二次写同一路径不重复备份，rewind 后回到最初内容', async () => {
    writeFileSync(join(cwd, 'a.txt'), 'v1');
    const wrapped = withCheckpoint(writeTool, store);
    store.beginTurn('连续两次写');

    await wrapped.call({ path: 'a.txt', content: 'v2' }, ctx);
    await wrapped.call({ path: 'a.txt', content: 'v3' }, ctx);
    store.endTurn();

    expect(store.list()[0]!.files).toHaveLength(1);
    const result = store.rewind(store.list()[0]!.id);
    expect('error' in result).toBe(false);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v1');
  });

  it('不在 turn 内时写入照常但不产生记录', async () => {
    const wrapped = withCheckpoint(writeTool, store);
    const result = await wrapped.call({ path: 'b.txt', content: 'x' }, ctx);
    expect(result.isError).toBeUndefined();
    store.endTurn();
    expect(store.list()).toEqual([]);
  });

  it('快照抛错时照常委托原调用', async () => {
    const broken = {
      cwd,
      snapshotBeforeWrite: () => {
        throw new Error('disk full');
      },
    } as unknown as CheckpointStore;
    const wrapped = withCheckpoint(writeTool, broken);
    const result = await wrapped.call({ path: 'c.txt', content: 'x' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(cwd, 'c.txt'), 'utf8')).toBe('x');
  });

  it('读类工具包装后行为不变：describeCall/isReadOnly/accesses 透传', async () => {
    writeFileSync(join(cwd, 'r.txt'), 'content');
    const wrapped = withCheckpoint(readTool, store);
    const input = { path: 'r.txt' };

    expect(wrapped.name).toBe(readTool.name);
    expect(wrapped.description).toBe(readTool.description);
    expect(wrapped.isReadOnly(input)).toBe(true);
    expect(wrapped.accesses(input)).toEqual([{ kind: 'read' }]);
    expect(wrapped.describeCall(input)).toBe('Read r.txt');
    expect(wrapped.toJSONSchema()).toEqual(readTool.toJSONSchema());

    const result = await wrapped.call(input, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('content');
  });
});
