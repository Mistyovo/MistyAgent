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
  return `[仅显示最后 ${max} 字符，完整输出共 ${text.length} 字符]\n${text.slice(-max)}`;
}

function statusLine(task: BackgroundTask): string {
  const base = `${task.id} [${task.status}]`;
  if (task.status === 'running') {
    const seconds = Math.round((Date.now() - task.startedAt) / 1000);
    return `${base} pid ${task.pid ?? '未知'}，已运行 ${seconds}s`;
  }
  return `${base} exit ${task.exitCode ?? '未知'}`;
}

function formatTaskOutput(task: BackgroundTask, output: string): string {
  const body = output === '' ? '(暂无输出)' : tail(output, MAX_OUTPUT_CHARS);
  return `${statusLine(task)}\n${body}`;
}

export function createTaskOutputTool(tasks: TaskManager): Tool {
  return defineTool({
    name: 'task_output',
    description:
      '查看后台任务（bash run_in_background 启动）的当前输出与状态。' +
      `block=true 时挂起等待任务结束或超时（timeoutMs 上限 ${MAX_BLOCK_TIMEOUT_MS / 1000}s，缺省等满上限）。`,
    inputSchema: z.object({
      taskId: z.string().describe('后台任务 id（如 task_1）'),
      block: z.boolean().optional().describe('true 时等到任务结束或超时再返回，默认 false'),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_BLOCK_TIMEOUT_MS)
        .optional()
        .describe(`block=true 时的最长等待毫秒数，上限 ${MAX_BLOCK_TIMEOUT_MS}`),
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
        return { output: `没有任务 ${input.taskId}（用 task_list 查看全部任务）`, isError: true };
      }
      return { output: formatTaskOutput(current.task, current.output) };
    },
  });
}

export function createTaskStopTool(tasks: TaskManager): Tool {
  return defineTool({
    name: 'task_stop',
    description: '终止后台任务（杀整个进程树），返回最终状态与输出尾部。',
    inputSchema: z.object({
      taskId: z.string().describe('后台任务 id（如 task_1）'),
    }),
    // 杀进程是有副作用的操作：声明 execute，default 模式走审批
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) => `TaskStop ${input.taskId}`,
    call: async (input) => {
      const before = tasks.get(input.taskId);
      if (before === null) {
        return { output: `没有任务 ${input.taskId}（用 task_list 查看全部任务）`, isError: true };
      }
      const task = await tasks.stop(input.taskId);
      const output = tasks.output(input.taskId)?.output ?? '';
      const note = before.status === 'running' ? '已终止' : '任务此前已结束';
      return { output: `${note}：${formatTaskOutput(task!, tail(output, 2000))}` };
    },
  });
}

export function createTaskListTool(tasks: TaskManager): Tool {
  return defineTool({
    name: 'task_list',
    description: '列出全部后台任务（含已结束）及其状态。',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: () => 'TaskList',
    call: () => {
      const all = tasks.list();
      if (all.length === 0) {
        return Promise.resolve({ output: '没有后台任务' });
      }
      const lines = all.map((task) => {
        const status =
          task.status === 'running'
            ? `running (pid ${task.pid ?? '未知'})`
            : `${task.status} (exit ${task.exitCode ?? '未知'})`;
        const command =
          task.command.length > 80 ? `${task.command.slice(0, 80)}…` : task.command;
        return `${task.id}  ${status}  ${command}`;
      });
      return Promise.resolve({ output: lines.join('\n') });
    },
  });
}
