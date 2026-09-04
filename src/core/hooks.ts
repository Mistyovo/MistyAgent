import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { HookEntry, HookEvent, HooksSettings } from '#/config/schema';

import type { EventDispatcher } from './events';

const execAsync = promisify(exec);

export const HOOK_TIMEOUT_MS = 30_000;
/** 单侧 stdout/stderr 缓冲上限（hook 不应刷屏；超出截断保留头部） */
const MAX_OUTPUT_CHARS = 8_000;

export interface HookRunInput {
  event: HookEvent;
  cwd: string;
  toolName?: string | undefined;
  toolInput?: unknown;
  toolOutput?: string | undefined;
  isError?: boolean | undefined;
  /** 绑定后 abort 会杀掉 hook 进程（preToolUse 在审批关键路径上，中断需即时响应） */
  signal?: AbortSignal | undefined;
}

export interface HookRunResult {
  /** 仅 preToolUse 可能为 true：hook 拒绝本次工具执行 */
  denied: boolean;
  /** deny 原因（回喂模型）；denied=false 时为空 */
  reason?: string | undefined;
  /** 各 hook 非空 stdout 的汇总（notice 上屏用） */
  stdout: string;
  /** hook 进程级失败（spawn 失败 / 超时 / 非零退出）的警告；不阻断主流程 */
  warnings: string[];
}

interface ProcResult {
  /** 进程未能启动 */
  spawnError?: string | undefined;
  /** 超时被杀 */
  timedOut?: boolean | undefined;
  /** 被 signal abort 杀掉（中断路径，静默处理） */
  aborted?: boolean | undefined;
  /** 正常落定后的退出码；被信号杀死为 null */
  code?: number | null | undefined;
  stdout: string;
  stderr: string;
}

/**
 * shell 命令钩子执行器（对标 Claude Code PreToolUse/PostToolUse/Stop hooks）。
 * 命令经 spawn(shell:true) 执行（Windows 即 cmd.exe，与 bash 工具同语义）；
 * 输入经 stdin 传 JSON（{ event, toolName, input, output, isError, cwd }），
 * 环境变量补 MISTY_HOOK_EVENT / MISTY_HOOK_TOOL_NAME。
 *
 * 失败语义：进程崩溃 / 超时 / 被杀只产生 warning，绝不阻断主流程；
 * preToolUse 例外的是「正常落定但 exit code 非 0」与 stdout JSON
 * {"decision":"deny","reason":"..."} 两种显式拒绝形态。Runner 保持纯函数式，
 * 不上屏——warnings 与 stdout 由调用方经 dispatchHookResult 转 notice 事件。
 */
export class HookRunner {
  private readonly timeoutMs: number;

  constructor(
    private readonly hooks: HooksSettings,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
  }

  hasHooks(event: HookEvent): boolean {
    return (this.hooks[event]?.length ?? 0) > 0;
  }

  async run(input: HookRunInput): Promise<HookRunResult> {
    const entries = this.hooks[input.event] ?? [];
    const result: HookRunResult = { denied: false, stdout: '', warnings: [] };
    const stdoutParts: string[] = [];
    for (const entry of entries) {
      if (result.denied) {
        break; // preToolUse 首个 deny 短路：后续检查不再执行
      }
      if (!this.matches(entry, input)) {
        continue;
      }
      const proc = await this.exec(entry.command, input);
      if (proc.aborted === true) {
        continue;
      }
      if (proc.spawnError !== undefined && proc.spawnError !== null) {
        result.warnings.push(`hook 命令启动失败（${entry.command}）：${proc.spawnError}`);
        continue;
      }
      if (proc.timedOut === true) {
        result.warnings.push(`hook 命令超时（>${this.timeoutMs}ms）已终止：${entry.command}`);
        continue;
      }
      const stdout = proc.stdout.trim();
      const stderr = proc.stderr.trim();
      if (input.event === 'preToolUse') {
        const denyReason = parseDenyReason(stdout);
        if (denyReason !== null) {
          result.denied = true;
          result.reason = denyReason;
          continue;
        }
        if (proc.code !== 0) {
          result.denied = true;
          result.reason =
            stderr !== ''
              ? stderr
              : stdout !== ''
                ? stdout
                : `hook 命令以非零退出码 ${String(proc.code ?? '信号终止')} 结束：${entry.command}`;
          continue;
        }
      } else if (proc.code !== 0) {
        result.warnings.push(
          `hook 命令以非零退出码 ${String(proc.code ?? '信号终止')} 结束：${entry.command}` +
            (stderr !== '' ? `（${stderr}）` : ''),
        );
      }
      if (stdout !== '') {
        stdoutParts.push(stdout);
      }
    }
    result.stdout = stdoutParts.join('\n');
    return result;
  }

  private matches(entry: HookEntry, input: HookRunInput): boolean {
    if (input.event === 'stop' || entry.matcher === undefined) {
      return true;
    }
    // 配置层已校验正则合法性；这里防御性兜底，非法正则视为不匹配
    try {
      return new RegExp(entry.matcher).test(input.toolName ?? '');
    } catch {
      return false;
    }
  }

  private exec(command: string, input: HookRunInput): Promise<ProcResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (result: Omit<ProcResult, 'stdout' | 'stderr'>): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, stdout, stderr });
      };

      let child;
      try {
        child = spawn(command, {
          cwd: input.cwd,
          shell: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            MISTY_HOOK_EVENT: input.event,
            ...(input.toolName !== undefined ? { MISTY_HOOK_TOOL_NAME: input.toolName } : {}),
          },
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      } catch (error) {
        settle({ spawnError: error instanceof Error ? error.message : String(error) });
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        void killTree(child.pid);
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) {
          stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_OUTPUT_CHARS);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS) {
          stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_OUTPUT_CHARS);
        }
      });
      child.on('error', (error) => {
        if (input.signal?.aborted === true || error.name === 'AbortError') {
          settle({ aborted: true });
          return;
        }
        settle({ spawnError: error.message });
      });
      child.on('close', (code) => {
        if (input.signal?.aborted === true) {
          settle({ aborted: true });
          return;
        }
        settle({ code, timedOut });
      });

      // hook 可能不读 stdin 直接退出：吞掉 EPIPE，避免未捕获异常
      child.stdin?.on('error', () => {});
      const payload = JSON.stringify({
        event: input.event,
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.toolInput !== undefined ? { input: input.toolInput } : {}),
        ...(input.toolOutput !== undefined ? { output: input.toolOutput } : {}),
        ...(input.isError !== undefined ? { isError: input.isError } : {}),
        cwd: input.cwd,
      });
      child.stdin?.write(payload);
      child.stdin?.end();
    });
  }
}

/** Windows 杀进程树（child.kill 只杀壳层 cmd.exe）；POSIX 直接 SIGKILL */
async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      await execAsync(`taskkill /pid ${pid} /t /f`);
    } catch {
      // 进程可能刚好已退出
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程可能刚好已退出
  }
}

/** stdout 整体为 {"decision":"deny","reason":"..."} JSON 时返回 reason；否则返回 null */
function parseDenyReason(stdout: string): string | null {
  if (!stdout.startsWith('{')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const decision = (parsed as { decision?: unknown }).decision;
  if (decision !== 'deny') {
    return null;
  }
  const reason = (parsed as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() !== '' ? reason : 'hook 拒绝了本次操作';
}

/** 把 hook 运行结果转成 notice 事件上屏（warnings + stdout 提示）；deny 不产生事件 */
export function dispatchHookResult(
  dispatch: EventDispatcher,
  event: HookEvent,
  result: HookRunResult,
): void {
  for (const warning of result.warnings) {
    dispatch({ type: 'hook-notice', hookEvent: event, text: warning, isWarning: true });
  }
  if (result.stdout !== '') {
    dispatch({ type: 'hook-notice', hookEvent: event, text: result.stdout, isWarning: false });
  }
}
