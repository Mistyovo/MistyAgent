import type { Session } from '#/core/session/session';
import type { ToolRegistry } from '#/core/tools/registry';

export interface PrintModeDeps {
  session: Session;
  registry: ToolRegistry;
  prompt: string;
  /** 可注入便于测试；默认 process.stdout / process.stderr */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * 无头模式（-p/--print）：跑一个 turn，assistant 文本流式写 stdout，
 * 工具调用摘要与错误写 stderr。审批请求无法交互，自动拒绝并回喂说明。
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
      case 'error':
        stderr.write(`✗ ${event.message}\n`);
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

  const onSigint = (): void => {
    deps.session.interrupt();
  };
  process.once('SIGINT', onSigint);
  try {
    const result = await deps.session.submit({ type: 'user-turn', text: deps.prompt });
    if (stdoutNeedsNewline) {
      stdout.write('\n');
    }
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
