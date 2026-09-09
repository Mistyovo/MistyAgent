import type { AgentEvent } from '#/core/events';
import type { Session } from '#/core/session/session';
import { MISTY_VERSION } from '#/core/session/transcript';
import type { TaskManager } from '#/core/tasks';
import type { ToolRegistry } from '#/core/tools/registry';

export interface PrintModeDeps {
  session: Session;
  registry: ToolRegistry;
  prompt: string;
  /** 后台任务管理器；提供时退出前对运行中的任务做 drain（至多等 3s 后终止） */
  tasks?: TaskManager;
  /**
   * 输出格式：text（默认，人类可读——assistant 文本流式写 stdout，过程写 stderr）
   * 或 stream-json（stdout 为 NDJSON 机器可读事件流，见 README「stream-json 格式」）
   */
  outputFormat?: 'text' | 'stream-json' | undefined;
  /** stream-json 的 init 行与退出诊断用 */
  cwd?: string;
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
  const body = truncated ? `${text}\n[…stdin exceeds 1MB, truncated]` : text;
  return `${prompt}\n\n--- stdin ---\n${body}`;
}

/**
 * 无头模式（-p/--print）：跑一个 turn。
 * text 格式：assistant 文本流式写 stdout，工具调用摘要与错误写 stderr。
 * stream-json 格式：stdout 每行一个 JSON——system/init 起始、原生事件逐个透出
 * （text/reasoning delta 聚合为 assistant_text / assistant_reasoning，按边界保序）、
 * result 结尾（含 stopReason/steps/usage/exitCode）；诊断信息仍写 stderr。
 * 两种格式的审批与计划批准请求都无法交互，自动拒绝并回喂说明。
 * 退出码：completed → 0；interrupted → 130；error / max-steps → 1。
 */
export async function runPrintMode(deps: PrintModeDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const describe = (name: string, input: unknown): string =>
    deps.registry.get(name)?.describeCall(input) ?? name;
  const json = deps.outputFormat === 'stream-json';

  let stdoutNeedsNewline = false;
  let jsonText = '';
  let jsonReasoning = '';
  const emitJson = (value: unknown): void => {
    stdout.write(`${JSON.stringify(value)}\n`);
  };
  const flushJsonDeltas = (): void => {
    if (jsonText !== '') {
      emitJson({ type: 'assistant_text', text: jsonText });
      jsonText = '';
    }
    if (jsonReasoning !== '') {
      emitJson({ type: 'assistant_reasoning', text: jsonReasoning });
      jsonReasoning = '';
    }
  };

  if (json) {
    emitJson({
      type: 'system',
      subtype: 'init',
      model: deps.session.getModel(),
      cwd: deps.cwd ?? null,
      sessionId: deps.session.getSessionId(),
      version: MISTY_VERSION,
    });
  }

  const off = deps.session.onEvent((event: AgentEvent) => {
    if (json) {
      if (event.type === 'text-delta') {
        jsonText += event.text;
        return;
      }
      if (event.type === 'reasoning-delta') {
        jsonReasoning += event.text;
        return;
      }
      flushJsonDeltas();
      emitJson(event);
    } else {
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
            `${event.isError ? '✗' : '✓'} ${describe(event.name, event.input)} (${event.durationMs}ms)\n`,
          );
          break;
        case 'task-finished':
          stderr.write(
            `⚙ ${event.taskId} ${event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'stopped'} (exit ${event.exitCode ?? 'unknown'})\n`,
          );
          break;
        case 'hook-notice':
          stderr.write(`${event.isWarning ? '⚠' : '—'} ${event.text}\n`);
          break;
        case 'error':
          stderr.write(`✗ ${event.message}\n`);
          break;
        case 'model-fallback':
          stderr.write(`⚠ Model ${event.from} failed, switching to ${event.to}: ${event.reason}\n`);
          break;
        case 'turn-complete':
          if (event.stopReason === 'max-steps') {
            stderr.write(`✗ Reached the maximum number of steps (${event.steps} steps); the task did not finish cleanly\n`);
          }
          break;
        default:
          break;
      }
    }
    // 交互请求的无头兜底（两种输出格式共用）：诊断写 stderr，自动拒绝并回喂说明
    if (event.type === 'approval-requested') {
      stderr.write(`✗ Headless mode cannot prompt for approval; auto-rejected: ${event.request.describeCall}\n`);
      deps.session.submit({
        type: 'approval-reply',
        id: event.request.id,
        reply: {
          decision: 'reject',
          feedback: 'This is headless (-p/--print) mode, so interactive approval is unavailable; to allow it, configure permissionRules or adjust --mode.',
        },
      });
      return;
    }
    if (event.type === 'plan-approval-requested') {
      stderr.write('✗ Headless mode cannot prompt for plan approval; auto-rejected\n');
      deps.session.submit({
        type: 'plan-approval-reply',
        id: event.request.id,
        reply: {
          approved: false,
          feedback:
            'This is headless (-p/--print) mode, so interactive plan approval is unavailable; ' +
            'output the plan as text, or drop --mode plan and run in the TUI.',
        },
      });
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
      `…${running.length} background task(s) still running; waiting up to ${TASK_DRAIN_MS / 1000}s\n`,
    );
    await Promise.all(running.map((task) => tasks.waitForSettled(task.id, TASK_DRAIN_MS)));
    for (const task of tasks.list()) {
      if (task.status === 'running') {
        stderr.write(`✗ Background task ${task.id} did not finish within the wait window; terminated\n`);
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
    if (json) {
      flushJsonDeltas();
    } else if (stdoutNeedsNewline) {
      stdout.write('\n');
    }
    await drainTasks();
    let exitCode: number;
    switch (result.stopReason) {
      case 'completed':
        exitCode = 0;
        break;
      case 'interrupted':
        exitCode = 130;
        break;
      default:
        exitCode = 1;
    }
    if (json) {
      emitJson({
        type: 'result',
        stopReason: result.stopReason,
        steps: result.steps,
        usage: result.usage,
        exitCode,
      });
    }
    return exitCode;
  } finally {
    off();
    process.removeListener('SIGINT', onSigint);
  }
}
