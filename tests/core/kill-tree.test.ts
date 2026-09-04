import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HookRunner } from '#/core/hooks';
import { TaskManager } from '#/core/tasks';
import { createBashTool } from '#/core/tools/builtin/bash';
import type { ToolContext } from '#/core/tools/tool';

/**
 * 孙进程探针：打印/落盘自己的 pid 后常驻，之后用 ESRCH 断言它确实死了
 * （参照 tasks.test.ts 的 process.kill(pid, 0) 断言法），证明杀的是整棵树而非壳层 cmd.exe。
 */
const PRINT_PID_AND_HANG = `node -e "console.log('childpid:'+process.pid); setInterval(()=>{}, 500)"`;
const WRITE_PID_AND_HANG = (fileName: string): string =>
  `node -e "require('fs').writeFileSync('${fileName}', String(process.pid)); setInterval(()=>{}, 60000)"`;

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 杀树落定与孙进程死透之间有微小窗口：轮询到 ESRCH（进程不存在）为止 */
async function expectProcessDead(pid: number): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

describe('bash 前台杀进程树', () => {
  let cwd: string;
  let ctx: ToolContext;
  let manager: TaskManager;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'misty-killtree-'));
    ctx = { cwd, signal: new AbortController().signal };
    manager = new TaskManager();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('超时杀整棵树：孙进程 ESRCH，不再只杀壳层 cmd.exe', async () => {
    const bash = createBashTool(manager);
    const result = await bash.call({ command: PRINT_PID_AND_HANG, timeout: 1000 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('超时');
    const match = /childpid:(\d+)/.exec(result.output);
    expect(match).not.toBeNull();
    await expectProcessDead(Number(match![1]));
  }, 15000);

  it('abort 中断同样杀整棵树', async () => {
    const bash = createBashTool(manager);
    const controller = new AbortController();
    const running = bash.call(
      { command: WRITE_PID_AND_HANG('grandchild.pid'), timeout: 60_000 },
      { cwd, signal: controller.signal },
    );
    const pidFile = path.join(cwd, 'grandchild.pid');
    await waitFor(() => existsSync(pidFile));
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();

    controller.abort();
    const result = await running;
    expect(result.isError).toBe(true);
    expect(result.output).toContain('中断');
    await expectProcessDead(pid);
  }, 15000);
});

describe('HookRunner 杀进程树与 matcher 缓存', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'misty-hookskill-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('hook 超时杀整棵树：写 pid 的孙进程同步被杀', async () => {
    const runner = new HookRunner(
      { stop: [{ command: WRITE_PID_AND_HANG('hook-child.pid') }] },
      { timeoutMs: 1000 },
    );
    const result = await runner.run({ event: 'stop', cwd });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('超时');
    const pid = Number(await readFile(path.join(cwd, 'hook-child.pid'), 'utf8'));
    await expectProcessDead(pid);
  }, 15000);

  it('matcher 构造时编译一次，run 不再重复编译且过滤行为不变', async () => {
    const spy = vi.spyOn(globalThis, 'RegExp');
    const runner = new HookRunner({
      preToolUse: [{ matcher: 'write|edit', command: `node -e "console.log('hit')"` }],
    });
    const compiledAtCtor = spy.mock.calls.length;

    spy.mockClear();
    const hit = await runner.run({ event: 'preToolUse', toolName: 'write', cwd });
    const miss = await runner.run({ event: 'preToolUse', toolName: 'read', cwd });
    const compiledDuringRuns = spy.mock.calls.length;
    spy.mockRestore();

    expect(compiledAtCtor).toBe(1);
    expect(compiledDuringRuns).toBe(0);
    expect(hit.stdout).toBe('hit');
    expect(miss.stdout).toBe('');
  });

  it('非法 matcher（绕过配置校验直构 Runner）视为不匹配，不抛异常', async () => {
    const runner = new HookRunner({
      preToolUse: [
        { matcher: '(', command: `node -e "console.log('never')"` },
        { command: `node -e "console.log('fallback')"` },
      ],
    });
    const result = await runner.run({ event: 'preToolUse', toolName: 'write', cwd });
    expect(result.stdout).toBe('fallback');
  });
});
