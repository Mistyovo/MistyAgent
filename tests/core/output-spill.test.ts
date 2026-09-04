import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupSpilledOutputs,
  outputSpillDir,
  spillToolOutput,
  TOOL_OUTPUT_PREVIEW_LINES,
} from '#/core/output-spill';

describe('output-spill：工具输出超预览行数落盘', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'misty-spill-test-'));
    process.env.MISTY_OUTPUT_DIR = dir;
  });

  afterEach(() => {
    delete process.env.MISTY_OUTPUT_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('行数不超阈值：不落盘，返回 null', () => {
    const output = Array.from({ length: TOOL_OUTPUT_PREVIEW_LINES }, (_, i) => `row-${i}`).join('\n');
    expect(spillToolOutput(output, 'sess')).toBeNull();
    expect(existsSync(dir) && readdirSync(dir)).toEqual([]);
  });

  it('行数超阈值：写 <sessionKey>-<n>.log，返回路径，文件内容完整', () => {
    const output = 'l1\nl2\nl3\nl4\nl5';
    const filePath = spillToolOutput(output, 'sess');
    expect(filePath).not.toBeNull();
    expect(filePath!).toMatch(/misty-spill-test-.*[\\/]sess-\d+\.log$/);
    expect(readFileSync(filePath!, 'utf8')).toBe(output);
    // 第二次落盘序号递增，互不覆盖
    const second = spillToolOutput(output, 'sess');
    expect(second).not.toBeNull();
    expect(second).not.toBe(filePath);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('sessionKey 含路径分隔符等字符时清洗成安全文件名', () => {
    const filePath = spillToolOutput('a\nb\nc\nd', 'a/b\\c:d');
    expect(filePath).not.toBeNull();
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^a_b_c_d-\d+\.log$/)]);
  });

  it('落盘失败（目录路径被文件占用）降级为 null', () => {
    const blocker = join(dir, 'blocked');
    writeFileSync(blocker, 'not a dir');
    process.env.MISTY_OUTPUT_DIR = join(blocker, 'sub');
    expect(spillToolOutput('a\nb\nc\nd', 'sess')).toBeNull();
  });

  it('启动清理：删除过期文件，保留新文件；目录不存在时不抛错', () => {
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'old-1.log');
    const fresh = join(dir, 'new-1.log');
    writeFileSync(stale, 'stale');
    writeFileSync(fresh, 'fresh');
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    utimesSync(stale, twoDaysAgo / 1000, twoDaysAgo / 1000);

    cleanupSpilledOutputs();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);

    process.env.MISTY_OUTPUT_DIR = join(dir, 'does-not-exist');
    expect(() => cleanupSpilledOutputs()).not.toThrow();
  });

  it('MISTY_OUTPUT_DIR 未设置时默认在 os.tmpdir()/misty-output', () => {
    delete process.env.MISTY_OUTPUT_DIR;
    expect(outputSpillDir()).toBe(join(tmpdir(), 'misty-output'));
  });
});
