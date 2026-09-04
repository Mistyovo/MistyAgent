import type { Session } from '#/core/session/session';
import type { TaskManager } from '#/core/tasks';
import type { ToolRegistry } from '#/core/tools/registry';

export interface PrintModeDeps {
  session: Session;
  registry: ToolRegistry;
  prompt: string;
  /** 后台任务管理器；提供时退出前对运行中的任务做 drain（至多等 3s 后终止） */
  tasks?: TaskManager;
  /** 可注入便于测试；默认 process.stdout / process.stderr */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** 退出前等后台任务自然结束的上限 */
const TASK_DRAIN_MS = 3000;

/** print 模式读取管道 stdin 的上限：超出截断并注明，防超大输入撑爆上下文 */
export const PRINT_STDIN_MAX_BYTES = 1024 * 1024;

/**
 * print 模式解析最终 prompt：stdin 非 TTY（管道/重定向，如 `git diff | misty -p`）时
 * 读出全部内容，以分隔线拼到 prompt 尾部；TTY 或无内容时原样返回。超过 1MB 截断并注明。
 */
export async function resolvePrintPrompt(
  prompt: string,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (stdin.isTTY === true) {
    return prompt;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (total + buf.length > PRINT_STDIN_MAX_BYTES) {
      chunks.push(buf.subarray(0, PRINT_STDIN_MAX_BYTES - total));
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') {
    return prompt;
  }
  const body = truncated ? `${text}\n[…stdin 内容超过 1MB，已截断]` : text;
  return `${prompt}\n\n--- stdin ---\n${body}`;
}

/**
 * 无头模式（-p/--print）：跑一个 turn，assistant 文本流式写 stdout，
 * 工具调用摘要与错误写 stderr。审批与计划批准请求无法交互，自动拒绝并回喂说明。
 * 退出码：completed → 0；interrupted → 130；error / max-steps → 1。
 */
export async function runPrintMode(deps: PrintModeDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const describe = (name: string, input: unknown): string =>
    deps.registry.get(name)?.describeCall(input) ?? name;

  let stdoutNeedsNewline = false;

  const off = deps.session.onEvent((event) => {
    switch (event.type) {
      case 'text-delta':
        stdout.write(event.text);
        stdoutNeedsNewline = !event.text.endsWith('\n');
        break;
      case 'reasoning-delta':
        stderr.write(event.text);
        break;
      case 'tool-call-started':
        stderr.write(`⏵ ${describe(event.name, event.input)}\n`);
        break;
      case 'tool-call-completed':
        stderr.write(
          `${event.isError ? '✗' : '✓'} ${describe(event.name, event.input)}（${event.durationMs}ms）\n`,
        );
        break;
      case 'task-finished':
        stderr.write(
          `⚙ ${event.taskId} ${event.status === 'completed' ? '已完成' : event.status === 'failed' ? '失败' : '已停止'}（exit ${event.exitCode ?? '未知'}）\n`,
        );
        break;
      case 'hook-notice':
        stderr.write(`${event.isWarning ? '⚠' : '—'} ${event.text}\n`);
        break;
      case 'approval-requested':
        stderr.write(`✗ 无头模式无法交互审批，已自动拒绝：${event.request.describeCall}\n`);
        deps.session.submit({
          type: 'approval-reply',
          id: event.request.id,
          reply: {
            decision: 'reject',
            feedback: '当前是无头（-p/--print）模式，无法交互审批；如需放行请配置 permissionRules 或调整 --mode。',
          },
        });
        break;
      case 'plan-approval-requested':
        stderr.write('✗ 无头模式无法交互批准计划，已自动拒绝\n');
        deps.session.submit({
          type: 'plan-approval-reply',
          id: event.request.id,
          reply: {
            approved: false,
            feedback:
              '当前是无头（-p/--print）模式，无法交互批准计划；' +
              '请以文本形式输出计划，或去掉 --mode plan 在 TUI 中运行。',
          },
        });
        break;
      case 'error':
        stderr.write(`✗ ${event.message}\n`);
        break;
      case 'model-fallback':
        stderr.write(`⚠ 模型 ${event.from} 失败，切换到 ${event.to}：${event.reason}\n`);
        break;
      case 'turn-complete':
        if (event.stopReason === 'max-steps') {
          stderr.write(`✗ 已达到最大步数（${event.steps} 步），任务未正常收尾\n`);
        }
        break;
      default:
        break;
    }
  });

  const drainTasks = async (): Promise<void> => {
    const tasks = deps.tasks;
    if (tasks === undefined) {
      return;
    }
    const running = tasks.list().filter((task) => task.status === 'running');
    if (running.length === 0) {
      return;
    }
    stderr.write(
      `…还有 ${running.length} 个后台任务在运行，至多等待 ${TASK_DRAIN_MS / 1000}s\n`,
    );
    await Promise.all(running.map((task) => tasks.waitForSettled(task.id, TASK_DRAIN_MS)));
    for (const task of tasks.list()) {
      if (task.status === 'running') {
        stderr.write(`✗ 后台任务 ${task.id} 未在等待期内结束，已终止\n`);
        await tasks.stop(task.id);
      }
    }
  };

  const onSigint = (): void => {
    deps.session.interrupt();
  };
  process.once('SIGINT', onSigint);
  try {
    const result = await deps.session.submit({ type: 'user-turn', text: deps.prompt });
    if (stdoutNeedsNewline) {
      stdout.write('\n');
    }
    await drainTasks();
    switch (result.stopReason) {
      case 'completed':
        return 0;
      case 'interrupted':
        return 130;
      default:
        return 1;
    }
  } finally {
    off();
    process.removeListener('SIGINT', onSigint);
  }
}
