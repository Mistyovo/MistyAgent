import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore, cleanupCheckpoints } from '#/core/checkpoint/checkpoint';

describe('checkpoint：文件改动快照与回滚', () => {
  let cwd: string;
  let dir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'misty-ckpt-cwd-'));
    dir = mkdtempSync(join(tmpdir(), 'misty-ckpt-store-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(): CheckpointStore {
    return new CheckpointStore(cwd, { dir });
  }

  it('空 turn 丢弃：无文件记录的 pending 不密封、不落盘', () => {
    const store = makeStore();
    store.beginTurn('hello');
    store.endTurn();
    expect(store.list()).toEqual([]);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
  });

  it('beginTurn 时上一个未密封 pending 按 endTurn 规则处理', () => {
    const target = join(cwd, 'a.txt');
    writeFileSync(target, 'v1');
    const store = makeStore();
    store.beginTurn('turn-1');
    store.snapshotBeforeWrite(target);
    store.beginTurn('turn-2');
    store.endTurn();
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.userText).toBe('turn-1');
  });

  it('同一 turn 同路径快照幂等：只备份第一次的内容', () => {
    const target = join(cwd, 'a.txt');
    writeFileSync(target, 'v1');
    const store = makeStore();
    store.beginTurn('t');
    store.snapshotBeforeWrite(target);
    writeFileSync(target, 'v2');
    store.snapshotBeforeWrite(target);
    store.endTurn();
    const files = store.list()[0]!.files;
    expect(files).toHaveLength(1);
    expect(files[0]!.existed).toBe(true);
    expect(readFileSync(files[0]!.backupPath, 'utf8')).toBe('v1');
  });

  it('不在 turn 内的写不入 checkpoint', () => {
    const store = makeStore();
    store.snapshotBeforeWrite(join(cwd, 'a.txt'));
    expect(store.list()).toEqual([]);
  });

  it('写入前不存在的文件只记 existed: false，不产生备份文件', () => {
    const target = join(cwd, 'new.txt');
    const store = makeStore();
    store.beginTurn('t');
    store.snapshotBeforeWrite(target);
    store.endTurn();
    const record = store.list()[0]!.files[0]!;
    expect(record.existed).toBe(false);
    expect(existsSync(record.backupPath)).toBe(false);
  });

  it('密封记录持久化：新实例加载同一 dir 可见', () => {
    const target = join(cwd, 'a.txt');
    writeFileSync(target, 'v1');
    const store = makeStore();
    store.beginTurn('持久化验证');
    store.snapshotBeforeWrite(target);
    store.endTurn();
    const reloaded = makeStore();
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]!.userText).toBe('持久化验证');
  });

  it('rewind：还原已存在文件、删除新建文件，并清除已回滚记录与备份', () => {
    const existing = join(cwd, 'existing.txt');
    const created = join(cwd, 'created.txt');
    writeFileSync(existing, 'before');

    const store = makeStore();
    store.beginTurn('改动一轮');
    store.snapshotBeforeWrite(existing);
    store.snapshotBeforeWrite(created);
    writeFileSync(existing, 'after');
    writeFileSync(created, 'brand new');
    store.endTurn();
    const checkpointId = store.list()[0]!.id;
    const backupPath = store.list()[0]!.files.find((f) => f.path === existing)!.backupPath;

    const result = store.rewind(checkpointId);
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(result.restored).toEqual([existing]);
    expect(result.deleted).toEqual([created]);
    expect(readFileSync(existing, 'utf8')).toBe('before');
    expect(existsSync(created)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
    expect(store.list()).toEqual([]);
    expect(makeStore().list()).toEqual([]);
  });

  it('rewind 未知 id 返回 error', () => {
    const store = makeStore();
    expect(store.rewind(999)).toEqual({ error: expect.stringContaining('999') });
  });

  it('多 turn 连续回滚到较早点：同一路径最终停在最早备份', () => {
    const target = join(cwd, 'a.txt');
    writeFileSync(target, 'v1');
    const store = makeStore();

    store.beginTurn('turn-1');
    store.snapshotBeforeWrite(target);
    writeFileSync(target, 'v2');
    store.endTurn();

    store.beginTurn('turn-2');
    store.snapshotBeforeWrite(target);
    writeFileSync(target, 'v3');
    store.endTurn();

    const [newer, older] = store.list();
    expect(newer!.id).toBeGreaterThan(older!.id);

    const result = store.rewind(older!.id);
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(readFileSync(target, 'utf8')).toBe('v1');
    expect(result.restored).toEqual([target]);
    expect(store.list()).toEqual([]);
  });

  it('回滚到中间点：保留更老的 checkpoint，目标内容回到该点之前', () => {
    const target = join(cwd, 'a.txt');
    writeFileSync(target, 'v1');
    const store = makeStore();

    store.beginTurn('turn-1');
    store.snapshotBeforeWrite(target);
    writeFileSync(target, 'v2');
    store.endTurn();

    store.beginTurn('turn-2');
    store.snapshotBeforeWrite(target);
    writeFileSync(target, 'v3');
    store.endTurn();

    const [newer, older] = store.list();
    const result = store.rewind(newer!.id);
    if ('error' in result) {
      throw new Error(result.error);
    }
    expect(readFileSync(target, 'utf8')).toBe('v2');
    expect(store.list().map((checkpoint) => checkpoint.id)).toEqual([older!.id]);
  });

  it('reset 清空全部记录与备份目录，落盘空清单', () => {
    const target = join(cwd, 'a.txt');
    writeFileSync(target, 'v1');
    const store = makeStore();
    store.beginTurn('t');
    store.snapshotBeforeWrite(target);
    store.endTurn();
    expect(store.list()).toHaveLength(1);

    store.reset();
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual(['manifest.json']);
    expect(makeStore().list()).toEqual([]);
  });

  it('userText 截断到 60 字符并加省略号', () => {
    const store = makeStore();
    store.beginTurn('x'.repeat(100));
    store.snapshotBeforeWrite(join(cwd, 'a.txt'));
    store.endTurn();
    expect(store.list()[0]!.userText).toBe(`${'x'.repeat(60)}…`);
  });

  it('cleanupCheckpoints 删除超龄目录、保留新目录，容错不抛', () => {
    const home = mkdtempSync(join(tmpdir(), 'misty-ckpt-home-'));
    try {
      const root = join(home, '.misty', 'checkpoints');
      const stale = join(root, 'stale-proj');
      const fresh = join(root, 'fresh-proj');
      mkdirSync(stale, { recursive: true });
      mkdirSync(fresh, { recursive: true });
      writeFileSync(join(stale, 'manifest.json'), '{"checkpoints":[]}');
      writeFileSync(join(fresh, 'manifest.json'), '{"checkpoints":[]}');
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      utimesSync(join(stale, 'manifest.json'), eightDaysAgo / 1000, eightDaysAgo / 1000);

      cleanupCheckpoints(7 * 24 * 60 * 60 * 1000, home);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);

      expect(() => cleanupCheckpoints(1000, join(home, 'no-such-home'))).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
