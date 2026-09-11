import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings } from '#/config/settings';
import type { Settings } from '#/config/schema';
import {
  ArenaRunner,
  buildSolvePrompt,
  buildWriteupMaterial,
  targetFromQuestion,
  type ArenaProcess,
  type ArenaSpawner,
  type ArenaTarget,
} from '#/core/arena';
import { CompetitionClient } from '#/core/competition';

/** 队伍 token 与接口配置只来自环境变量；主命令与 arena 子命令共用这一装配 */
export function resolveCompetitionClient(env: NodeJS.ProcessEnv): CompetitionClient | undefined {
  const token =
    env.MISTY_CTF_TOKEN !== undefined && env.MISTY_CTF_TOKEN !== ''
      ? env.MISTY_CTF_TOKEN
      : env.CTF_TOKEN;
  if (token === undefined || token === '') {
    return undefined;
  }
  return new CompetitionClient({
    token,
    ...(env.MISTY_CTF_BASE_URL ? { baseUrl: env.MISTY_CTF_BASE_URL } : {}),
    ...(env.MISTY_CTF_QUERY_PATH ? { queryPath: env.MISTY_CTF_QUERY_PATH } : {}),
    ...(env.MISTY_CTF_RESET_PATH ? { resetPath: env.MISTY_CTF_RESET_PATH } : {}),
    ...(env.MISTY_CTF_SUBMIT_PATH ? { submitPath: env.MISTY_CTF_SUBMIT_PATH } : {}),
  });
}

/** misty 自身入口：dist 安装时即本 bundle；tsx 源码运行经 --misty-cmd 覆盖 */
const DEFAULT_MISTY_CMD = `node ${fileURLToPath(import.meta.url)}`;

function parseCommand(command: string): { command: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  return { command: parts[0] ?? command, args: parts.slice(1) };
}

export function createMistySpawner(mistyCmd?: string, settings?: Settings): ArenaSpawner {
  return (target: ArenaTarget, dir: string, attempt: number): ArenaProcess => {
    // 子进程 cwd 在各题目录，读不到启动目录的配置文件；把父进程加载到的
    // 完整配置下发过去（含 apiKey），保证任何目录布局下行为一致
    if (settings !== undefined) {
      const childConfigDir = join(dir, '.misty');
      mkdirSync(childConfigDir, { recursive: true });
      writeFileSync(join(childConfigDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    }
    const logPath = join(dir, 'run.log');
    const fd = openSync(logPath, 'a');
    writeSync(fd, `\n===== attempt ${attempt} @ ${new Date().toISOString()} =====\n`);
    const { command, args: baseArgs } = parseCommand(mistyCmd ?? DEFAULT_MISTY_CMD);
    // 重启时 --continue 复用本题目录里的会话上下文，解题进度不归零
    const args = [
      ...baseArgs,
      '--mode',
      'bypassPermissions',
      ...(attempt > 1 ? ['--continue'] : []),
      '-p',
      buildSolvePrompt(target),
    ];
    const child = spawn(command, args, {
      cwd: dir,
      env: process.env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    const readLog = (): string => {
      try {
        return readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    };
    const exited = new Promise<{ code: number | null; output: string }>((resolve) => {
      const settle = (code: number | null, output: string): void => {
        closeSync(fd);
        resolve({ code, output });
      };
      child.once('exit', (code) => settle(code, readLog()));
      child.once('error', (error) => settle(null, `misty spawn error: ${error.message}`));
    });
    const outputSize = (): number => {
      try {
        return statSync(logPath).size;
      } catch {
        return 0;
      }
    };
    const kill = (): void => {
      killTree(child);
    };
    return { exited, outputSize, kill };
  };
}

/** Windows 下 child.kill 不递归子孙进程（bash 工具的 python/socket 都会漏），taskkill /T 连树拔 */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill();
}

export interface ArenaCliOptions {
  dir?: string;
  concurrency?: number;
  attempts?: number;
  stallMinutes?: number;
  budgetMinutes?: number;
  includeSolved?: boolean;
  /** 逗号分隔的 question_id 白名单（调试单题用） */
  only?: string;
  mistyCmd?: string;
}

export async function runArenaCommand(options: ArenaCliOptions): Promise<number> {
  const client = resolveCompetitionClient(process.env);
  if (client === undefined) {
    console.error('✗ MISTY_CTF_TOKEN (or CTF_TOKEN) is not set; arena needs it to list and submit.');
    return 1;
  }
  const workDir = options.dir ?? join(process.cwd(), 'ctf-arena');
  mkdirSync(workDir, { recursive: true });
  console.log(`arena workdir: ${workDir}`);
  // arena 自身不调模型，但解题子进程需要；加载失败不阻断 arena 启动，
  // 子进程会在自己的 run.log 里暴露缺 key 的错误
  let settings: Settings | undefined;
  try {
    settings = loadSettings(process.cwd()).settings;
  } catch {
    settings = undefined;
  }
  const runner = new ArenaRunner({
    client,
    spawner: createMistySpawner(options.mistyCmd, settings),
    workDir,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.attempts !== undefined ? { maxAttempts: options.attempts } : {}),
    ...(options.stallMinutes !== undefined
      ? { stallTimeoutMs: options.stallMinutes * 60_000 }
      : {}),
    ...(options.budgetMinutes !== undefined ? { budgetMs: options.budgetMinutes * 60_000 } : {}),
    ...(options.includeSolved === true ? { includeSolved: true } : {}),
    ...(options.only !== undefined
      ? {
          targets: (await client.listQuestions())
            .filter((q) => options.only!.split(',').map((id) => id.trim()).includes(q.questionId))
            .map(targetFromQuestion),
        }
      : {}),
    onEvent: (line) => console.log(line),
  });
  let summary;
  try {
    summary = await runner.run();
  } catch (error) {
    console.error(`✗ arena failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const materialPath = join(workDir, 'writeup-material.md');
  writeFileSync(materialPath, buildWriteupMaterial(summary, workDir));
  console.log(`\nresult: ${summary.solved}/${summary.total} solved (${summary.failed} failed, ${summary.abandoned} abandoned)`);
  console.log(`status:   ${join(workDir, 'arena-status.json')}`);
  console.log(`writeup:  ${materialPath}`);
  return 0;
}
