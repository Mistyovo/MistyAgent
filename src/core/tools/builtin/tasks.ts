import { z } from 'zod';

import type { BackgroundTask, TaskManager } from '#/core/tasks';

import { defineTool, type Tool } from '../tool';

/** 返回给模型的输出尾部长度（缓冲本身更大，这里与 bash 前台截断对齐） */
const MAX_OUTPUT_CHARS = 30_000;
const MAX_BLOCK_TIMEOUT_MS = 30_000;

function tail(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `[Showing only the last ${max} characters of ${text.length} total]\n${text.slice(-max)}`;
}

function statusLine(task: BackgroundTask): string {
  const base = `${task.id} [${task.kind}:${task.status}]`;
  if (task.status === 'running') {
    const seconds = Math.round((Date.now() - task.startedAt) / 1000);
    const pid = task.pid !== undefined ? ` pid ${task.pid}, ` : ' ';
    return `${base}${pid}running for ${seconds}s`;
  }
  return `${base} exit ${task.exitCode ?? 'unknown'}`;
}

function formatTaskOutput(task: BackgroundTask, output: string): string {
  const body = output === '' ? '(no output yet)' : tail(output, MAX_OUTPUT_CHARS);
  return `${statusLine(task)}\n${body}`;
}

export function createTaskOutputTool(tasks: TaskManager): Tool {
  return defineTool({
    name: 'task_output',
    description:
      'Inspect the current output and status of a background task (a bash run_in_background process or a background agent subagent). You are notified automatically when a task finishes; use this to check interim progress before that. ' +
      `With block=true it waits until the task finishes or times out (timeoutMs is capped at ${MAX_BLOCK_TIMEOUT_MS / 1000}s and defaults to that cap) — good for waiting on a task that is about to finish.`,
    inputSchema: z.object({
      taskId: z.string().describe('Background task id (e.g. task_1)'),
      block: z
        .boolean()
        .optional()
        .describe('When true, wait until the task finishes or times out; default false'),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_BLOCK_TIMEOUT_MS)
        .optional()
        .describe(`Maximum wait in milliseconds when block=true, capped at ${MAX_BLOCK_TIMEOUT_MS}`),
    }),
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) => `TaskOutput ${input.taskId}`,
    call: async (input, ctx) => {
      if (input.block === true) {
        const timeoutMs =
          input.timeoutMs === undefined || input.timeoutMs === 0
            ? MAX_BLOCK_TIMEOUT_MS
            : input.timeoutMs;
        // 挂起等待也响应中断：signal abort 时提前返回当前快照
        await Promise.race([
          tasks.waitForSettled(input.taskId, timeoutMs),
          new Promise<void>((resolve) => {
            if (ctx.signal.aborted) {
              resolve();
            } else {
              ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            }
          }),
        ]);
      }
      const current = tasks.output(input.taskId);
      if (current === null) {
        return {
          output: `No task ${input.taskId} (use task_list to see all tasks)`,
          isError: true,
        };
      }
      return { output: formatTaskOutput(current.task, current.output) };
    },
  });
}

export function createTaskStopTool(tasks: TaskManager): Tool {
  return defineTool({
    name: 'task_stop',
    description:
      'Terminate a background task (for bash this kills the whole process tree; for agent it interrupts the subagent loop), returning the final status and the tail of its output.',
    inputSchema: z.object({
      taskId: z.string().describe('Background task id (e.g. task_1)'),
    }),
    // 杀进程是有副作用的操作：声明 execute，default 模式走审批
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) => `TaskStop ${input.taskId}`,
    call: async (input) => {
      const before = tasks.get(input.taskId);
      if (before === null) {
        return {
          output: `No task ${input.taskId} (use task_list to see all tasks)`,
          isError: true,
        };
      }
      const task = await tasks.stop(input.taskId);
      const output = tasks.output(input.taskId)?.output ?? '';
      const note = before.status === 'running' ? 'Terminated' : 'Task had already finished';
      return { output: `${note}: ${formatTaskOutput(task!, tail(output, 2000))}` };
    },
  });
}

export function createTaskListTool(tasks: TaskManager): Tool {
  return defineTool({
    name: 'task_list',
    description: 'List all background tasks (bash/agent, including finished ones) and their status.',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: () => 'TaskList',
    call: () => {
      const all = tasks.list();
      if (all.length === 0) {
        return Promise.resolve({ output: 'No background tasks' });
      }
      const lines = all.map((task) => {
        const status =
          task.status === 'running'
            ? task.pid !== undefined
              ? `${task.kind}:running (pid ${task.pid})`
              : `${task.kind}:running`
            : `${task.kind}:${task.status} (exit ${task.exitCode ?? 'unknown'})`;
        const command =
          task.command.length > 80 ? `${task.command.slice(0, 80)}…` : task.command;
        return `${task.id}  ${status}  ${command}`;
      });
      return Promise.resolve({ output: lines.join('\n') });
    },
  });
}
