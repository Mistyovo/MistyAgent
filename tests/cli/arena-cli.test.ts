import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flagFromLog } from '#/core/arena';
import { createMistySpawner, resolveCompetitionClient } from '#/cli/arena';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'misty-arena-cli-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('resolveCompetitionClient', () => {
  it('读取 token/baseUrl/路径覆盖', () => {
    const client = resolveCompetitionClient({
      MISTY_CTF_TOKEN: 'tok',
      MISTY_CTF_BASE_URL: 'http://x',
      MISTY_CTF_QUERY_PATH: '/q',
      MISTY_CTF_RESET_PATH: '/r',
      MISTY_CTF_SUBMIT_PATH: '/s',
    });
    expect(client).toBeDefined();
  });

  it('CTF_TOKEN 兜底；无 token 返回 undefined', () => {
    expect(resolveCompetitionClient({ CTF_TOKEN: 'alt' })).toBeDefined();
    expect(resolveCompetitionClient({})).toBeUndefined();
    expect(resolveCompetitionClient({ MISTY_CTF_TOKEN: '' })).toBeUndefined();
  });
});

describe('createMistySpawner', () => {
  /** 假 misty：回显 argv 并打印一个 flag */
  function writeFakeMisty(): string {
    const script = join(workDir, 'fake-misty.mjs');
    writeFileSync(
      script,
      [
        "import { writeFileSync } from 'node:fs';",
        `const file = process.argv[2];`,
        'writeFileSync(file, JSON.stringify(process.argv));',
        "console.log('solver ran, flag{spawn-ok}');",
      ].join('\n'),
    );
    return script;
  }

  it('spawn 假 misty：捕获输出与 flag，attempt>1 时传 --continue', async () => {
    const script = writeFakeMisty();
    const argvFile = join(workDir, 'argv.json');
    const spawner = createMistySpawner(`node ${script} ${argvFile}`);
    const target = {
      questionId: 'q1',
      title: 't1',
      category: 'web',
      score: 500,
      description: 'test',
      fileUrl: '',
      interactive: false,
      connectionUrl: undefined,
    };

    const first = spawner(target, workDir, 1);
    const exit1 = await first.exited;
    expect(exit1.code).toBe(0);
    expect(exit1.output).toContain('flag{spawn-ok}');
    expect(flagFromLog(exit1.output)).toBe('flag{spawn-ok}');
    const argv1 = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(argvFile, 'utf8'))) as string[];
    expect(argv1).toContain('--mode');
    expect(argv1).toContain('bypassPermissions');
    expect(argv1).toContain('-p');
    expect(argv1).not.toContain('--continue');

    const second = spawner(target, workDir, 2);
    const exit2 = await second.exited;
    expect(exit2.code).toBe(0);
    const argv2 = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(argvFile, 'utf8'))) as string[];
    expect(argv2).toContain('--continue');

    // 日志按 attempt 追加，两段头部都在
    expect(exit2.output).toContain('attempt 1');
    expect(exit2.output).toContain('attempt 2');
  });

  it('命令不存在时回喂 spawn error 而非 reject', async () => {
    const spawner = createMistySpawner('definitely-not-a-command-xyz');
    const proc = spawner(
      {
        questionId: 'q1',
        title: 't1',
        category: 'web',
        score: 500,
        description: '',
        fileUrl: '',
        interactive: false,
        connectionUrl: undefined,
      },
      workDir,
      1,
    );
    const exit = await proc.exited;
    expect(exit.code).toBeNull();
    expect(exit.output).toContain('spawn error');
  });
});
