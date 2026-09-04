import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isBinaryFile, walkFiles, walkFilesStream } from '#/core/tools/builtin/fs-utils';
import { globTool } from '#/core/tools/builtin/glob';
import { grepTool } from '#/core/tools/builtin/grep';
import { readTool } from '#/core/tools/builtin/read';
import type { ToolContext } from '#/core/tools/tool';

const trackers = vi.hoisted(() => ({
  /** handle.read 每次请求的字节数 */
  openedReads: [] as number[],
  /** readdir 遍历过的目录 */
  scannedDirs: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn((...args: unknown[]) => {
      trackers.scannedDirs.push(String(args[0]));
      return (actual.readdir as (...a: unknown[]) => unknown)(...args);
    }),
    open: vi.fn(async (...args: unknown[]) => {
      const handle = await (actual.open as (...a: unknown[]) => Promise<{
        read(buffer: Buffer, offset: number, length: number, position: number): Promise<unknown>;
        close(): Promise<void>;
      }>)(...args);
      const origRead = handle.read.bind(handle);
      handle.read = (buffer: Buffer, offset: number, length: number, position: number) => {
        trackers.openedReads.push(length);
        return origRead(buffer, offset, length, position);
      };
      return handle;
    }),
  };
});

const readFileMock = vi.mocked(readFile);

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'misty-fs-perf-'));
  ctx = { cwd, signal: new AbortController().signal };
  trackers.openedReads.length = 0;
  trackers.scannedDirs.length = 0;
  vi.clearAllMocks();
});

describe('isBinaryFile', () => {
  it('只定位读前 8KB，不整文件加载', async () => {
    const big = path.join(cwd, 'big.txt');
    await writeFile(big, Buffer.alloc(20 * 1024 * 1024, 0x61));

    expect(await isBinaryFile(big)).toBe(false);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(trackers.openedReads.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(8192);
  });

  it('依据前 8KB 判定：头部 NUL 为二进制，8KB 之外的 NUL 不影响', async () => {
    const bin = path.join(cwd, 'bin.dat');
    await writeFile(bin, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(100, 0x61)]));
    expect(await isBinaryFile(bin)).toBe(true);

    const lateNul = path.join(cwd, 'late.txt');
    const buffer = Buffer.alloc(16 * 1024, 0x61);
    buffer[12 * 1024] = 0x00;
    await writeFile(lateNul, buffer);
    expect(await isBinaryFile(lateNul)).toBe(false);

    const empty = path.join(cwd, 'empty.txt');
    await writeFile(empty, '');
    expect(await isBinaryFile(empty)).toBe(false);
  });
});

describe('read 大小护栏', () => {
  it('超过 10MB 且未分段时报错并提示 offset/limit，不整文件读取', async () => {
    await writeFile(path.join(cwd, 'huge.txt'), Buffer.alloc(11 * 1024 * 1024, 0x61));

    const result = await readTool.call({ path: 'huge.txt' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('offset/limit');
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('超限文件可用 offset/limit 流式分段读取', async () => {
    const row = `line-${'x'.repeat(990)}`;
    const total = 11_000;
    const content = Array.from({ length: total }, (_, i) => `row${i + 1}-${row}`).join('\n');
    await writeFile(path.join(cwd, 'huge.txt'), content); // ≈ 11MB

    const result = await readTool.call({ path: 'huge.txt', offset: 10_500, limit: 5 }, ctx);
    expect(result.isError).toBeUndefined();
    const lines = result.output.split('\n');
    expect(lines).toHaveLength(6); // 5 行 + 截断说明
    expect(lines[0]).toMatch(/^10500\trow10500-/);
    expect(lines[4]).toMatch(/^10504\trow10504-/);
    expect(lines[5]).toBe('[已截断：显示到第 10504 行]');
    expect(readFileMock).not.toHaveBeenCalled();

    const tail = await readTool.call({ path: 'huge.txt', offset: total, limit: 5 }, ctx);
    expect(tail.isError).toBeUndefined();
    expect(tail.output).not.toContain('已截断');

    const out = await readTool.call({ path: 'huge.txt', offset: total + 1, limit: 5 }, ctx);
    expect(out.isError).toBe(true);
    expect(out.output).toContain('超出文件行数');
  });
});

describe('grep 提前终止', () => {
  it('命中上限即中断遍历，不扫完整棵树', async () => {
    const dirCount = 30;
    for (let i = 0; i < dirCount; i += 1) {
      const dir = path.join(cwd, `d${String(i).padStart(2, '0')}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'f.txt'),
        Array.from({ length: 10 }, (_, j) => `hit ${j}`).join('\n'),
      );
    }

    const result = await grepTool.call({ pattern: 'hit' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output.split('\n')).toHaveLength(101); // 100 条 + 截断说明
    expect(result.output).toContain('截断');
    // 全树共 root + 30 个子目录；命中 100 条后遍历已终止
    expect(trackers.scannedDirs.length).toBeLessThan(dirCount + 1);
  });
});

describe('walkFilesStream', () => {
  it('消费方 break 即终止遍历', async () => {
    for (let i = 0; i < 5; i += 1) {
      const dir = path.join(cwd, `d${i}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'f.txt'), 'x');
    }

    for await (const file of walkFilesStream(cwd)) {
      expect(file.endsWith('f.txt')).toBe(true);
      break;
    }
    // 只访问了 root 与第一个子目录
    expect(trackers.scannedDirs.length).toBeLessThanOrEqual(2);
  });

  it('walkFiles 收集包装保持全量与 limit 语义', async () => {
    await mkdir(path.join(cwd, 'sub'), { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      await writeFile(path.join(cwd, `f${i}.txt`), 'x');
    }
    await writeFile(path.join(cwd, 'sub', 'g.txt'), 'x');

    const all = await walkFiles(cwd);
    expect(all).toHaveLength(4);
    const limited = await walkFiles(cwd, 2);
    expect(limited).toHaveLength(2);
  });
});

describe('glob 回归', () => {
  it('仍全量收集、排序输出并跳过 node_modules', async () => {
    await mkdir(path.join(cwd, 'z/deep'), { recursive: true });
    await mkdir(path.join(cwd, 'a'), { recursive: true });
    await mkdir(path.join(cwd, 'node_modules/pkg'), { recursive: true });
    await writeFile(path.join(cwd, 'z/z2.ts'), '');
    await writeFile(path.join(cwd, 'z/deep/z1.ts'), '');
    await writeFile(path.join(cwd, 'a/a1.ts'), '');
    await writeFile(path.join(cwd, 'node_modules/pkg/skip.ts'), '');

    const result = await globTool.call({ pattern: '**/*.ts' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output.split('\n')).toEqual(['a/a1.ts', 'z/deep/z1.ts', 'z/z2.ts']);
  });
});
