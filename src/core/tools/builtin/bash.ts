import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { TaskManager } from '#/core/tasks';

import { defineTool, type Tool } from '../tool';

import { truncate } from './fs-utils';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
// 给截断留余量，避免 maxBuffer 先于我们自己的截断触发
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

interface ExecFailure {
  code?: number | string;
  signal?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
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
 * 前台走 exec 拿 stdout/stderr；run_in_background=true 走 TaskManager 立即返回。
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
      try {
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: ctx.cwd,
          timeout,
          maxBuffer: MAX_BUFFER_BYTES,
          signal: ctx.signal,
          windowsHide: true,
        });
        const output = formatOutput(stdout, stderr);
        return { output: output.length > 0 ? output : '(无输出)' };
      } catch (error) {
        const failure = error as ExecFailure;
        const output = formatOutput(failure.stdout ?? '', failure.stderr ?? '');
        if (ctx.signal.aborted) {
          return { output: `命令被中断\n${output}`.trim(), isError: true };
        }
        if (failure.killed === true && failure.signal === 'SIGTERM') {
          return { output: `命令超时（${timeout}ms）已终止\n${output}`.trim(), isError: true };
        }
        const code =
          typeof failure.code === 'number' ? `exit code ${failure.code}` : String(failure.code);
        return { output: `命令失败（${code}）\n${output}`.trim(), isError: true };
      }
    },
  });
}
