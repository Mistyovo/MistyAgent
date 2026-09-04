import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';

import { killTree, type TaskManager } from '#/core/tasks';

import { defineTool, type Tool } from '../tool';

import { truncate } from './fs-utils';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
// 流式累积的内存安全阀：超出即丢弃，截断逻辑（MAX_OUTPUT_CHARS）远先于此生效
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

const inputSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}（后台任务忽略此项）`),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'true 时后台执行：立即返回 taskId，用 task_output 查看输出、task_stop 终止；任务结束时会收到通知',
    ),
});

type ForegroundStatus = 'ok' | 'failed' | 'timeout' | 'aborted';

interface ForegroundResult {
  status: ForegroundStatus;
  /** 正常落定后的退出码；被信号杀死为 null */
  code: number | null;
  stdout: string;
  stderr: string;
}

function formatOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stdout.length > 0) {
    sections.push(stdout);
  }
  if (stderr.length > 0) {
    sections.push(`[stderr]\n${stderr}`);
  }
  return truncate(
    sections.join('\n'),
    MAX_OUTPUT_CHARS,
    `[输出过长已截断，仅保留前 ${MAX_OUTPUT_CHARS} 字符]`,
  );
}

/**
 * 前台 spawn(shell:true) 执行并收集 stdout/stderr。
 * 超时与 abort 走共享 killTree 杀整棵进程树——exec 的 timeout/signal 只杀壳层
 * （Windows cmd.exe），npm run build 之类命令的孙进程会成孤儿继续跑。
 * POSIX 以 detached 启动使壳进程成为进程组组长，killTree 才能按负 pid 整组杀。
 */
function execForeground(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
): Promise<ForegroundResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ status: 'failed', code: null, stdout: '', stderr: String(error) });
      return;
    }

    let status: ForegroundStatus = 'ok';
    let settled = false;
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const kill = (reason: 'timeout' | 'aborted'): void => {
      status = reason;
      void killTree(child);
    };
    const onAbort = (): void => kill('aborted');
    const timer = setTimeout(() => kill('timeout'), timeout);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort);
    }

    const settle = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ status: status === 'ok' && code !== 0 ? 'failed' : status, code, stdout, stderr });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER_BYTES) {
        stdout += stdoutDecoder.write(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER_BYTES) {
        stderr += stderrDecoder.write(chunk);
      }
    });
    // spawn 失败（如 cwd 不存在）：error 后不一定有 close，两条路径都要能落定
    child.on('error', (error) => {
      stderr += error.message;
      settle(null);
    });
    child.on('close', (code) => {
      settle(code);
    });
  });
}

/**
 * 前台走 spawn 拿 stdout/stderr；run_in_background=true 走 TaskManager 立即返回。
 * 后台启动与前台一样经调度 preflight 审批（accesses 恒为 execute），工具内部不再弹。
 * 后台任务刻意不绑 ctx.signal：interrupt 只中断前台 turn，不影响后台进程。
 */
export function createBashTool(tasks: TaskManager): Tool {
  return defineTool({
    name: 'bash',
    description:
      '在 shell 中执行命令并返回 stdout/stderr。' +
      `默认超时 ${DEFAULT_TIMEOUT_MS / 1000}s，输出超过 ${MAX_OUTPUT_CHARS} 字符会被截断。` +
      'run_in_background=true 时后台执行并立即返回 taskId。',
    inputSchema,
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) => {
      const command =
        input.command.length > 80 ? `${input.command.slice(0, 80)}…` : input.command;
      return input.run_in_background === true ? `Bash(后台) ${command}` : `Bash ${command}`;
    },
    call: async (input, ctx) => {
      if (input.run_in_background === true) {
        const task = tasks.start(input.command, ctx.cwd);
        return {
          output:
            `后台任务 ${task.id} 已启动（pid ${task.pid ?? '未知'}）。\n` +
            '用 task_output 查看输出；任务结束时会收到通知。',
        };
      }
      const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS;
      const result = await execForeground(input.command, ctx.cwd, timeout, ctx.signal);
      const output = formatOutput(result.stdout, result.stderr);
      if (result.status === 'ok') {
        return { output: output.length > 0 ? output : '(无输出)' };
      }
      if (result.status === 'aborted') {
        return { output: `命令被中断\n${output}`.trim(), isError: true };
      }
      if (result.status === 'timeout') {
        return { output: `命令超时（${timeout}ms）已终止\n${output}`.trim(), isError: true };
      }
      const code =
        typeof result.code === 'number' ? `exit code ${result.code}` : String(result.code);
      return { output: `命令失败（${code}）\n${output}`.trim(), isError: true };
    },
  });
}
