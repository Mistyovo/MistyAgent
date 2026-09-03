import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { defineTool } from '../tool';

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
    .describe(`超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}`),
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

export const bashTool = defineTool({
  name: 'bash',
  description:
    '在 shell 中执行命令并返回 stdout/stderr。' +
    `默认超时 ${DEFAULT_TIMEOUT_MS / 1000}s，输出超过 ${MAX_OUTPUT_CHARS} 字符会被截断。`,
  inputSchema,
  accesses: () => [{ kind: 'execute' }],
  describeCall: (input) =>
    `Bash ${input.command.length > 80 ? `${input.command.slice(0, 80)}…` : input.command}`,
  call: async (input, ctx) => {
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
      const code = typeof failure.code === 'number' ? `exit code ${failure.code}` : String(failure.code);
      return { output: `命令失败（${code}）\n${output}`.trim(), isError: true };
    }
  },
});
