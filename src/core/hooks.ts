import { spawn, type ChildProcess } from 'node:child_process';

import type { HookEntry, HookEvent, HooksSettings } from '#/config/schema';

import type { EventDispatcher } from './events';
import { killTree } from './tasks';

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
 * 加载时预编译的 hook 条目：matcher 正则只编译一次。
 * matcher 三态：undefined 未配置（匹配全部）；null 非法正则（不匹配，配置层已校验、这里兜底）；
 * RegExp 正常过滤。
 */
interface CompiledHookEntry {
  entry: HookEntry;
  matcher: RegExp | null | undefined;
}

function compileMatcher(pattern: string | undefined): RegExp | null | undefined {
  if (pattern === undefined) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function compileEntries(entries: HookEntry[] | undefined): CompiledHookEntry[] {
  return (entries ?? []).map((entry) => ({ entry, matcher: compileMatcher(entry.matcher) }));
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
  private readonly entries: Record<HookEvent, CompiledHookEntry[]>;

  constructor(
    hooks: HooksSettings,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? HOOK_TIMEOUT_MS;
    this.entries = {
      preToolUse: compileEntries(hooks.preToolUse),
      postToolUse: compileEntries(hooks.postToolUse),
      stop: compileEntries(hooks.stop),
    };
  }

  hasHooks(event: HookEvent): boolean {
    return this.entries[event].length > 0;
  }

  async run(input: HookRunInput): Promise<HookRunResult> {
    const entries = this.entries[input.event];
    const result: HookRunResult = { denied: false, stdout: '', warnings: [] };
    const stdoutParts: string[] = [];
    for (const { entry, matcher } of entries) {
      if (result.denied) {
        break; // preToolUse 首个 deny 短路：后续检查不再执行
      }
      if (!this.matches(matcher, input)) {
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

  private matches(matcher: RegExp | null | undefined, input: HookRunInput): boolean {
    if (input.event === 'stop' || matcher === undefined) {
      return true;
    }
    return matcher !== null && matcher.test(input.toolName ?? '');
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
        input.signal?.removeEventListener('abort', onAbort);
        resolve({ ...result, stdout, stderr });
      };

      let child: ChildProcess | undefined;
      // 中断/超时统一走共享 killTree 杀整棵进程树；child 未 spawn 成功时退化为无操作
      const onAbort = (): void => {
        if (child !== undefined) {
          void killTree(child);
        }
      };
      try {
        child = spawn(command, {
          cwd: input.cwd,
          shell: true,
          windowsHide: true,
          // POSIX 下使壳进程成为进程组组长，killTree 才能按负 pid 整组杀
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            MISTY_HOOK_EVENT: input.event,
            ...(input.toolName !== undefined ? { MISTY_HOOK_TOOL_NAME: input.toolName } : {}),
          },
        });
      } catch (error) {
        settle({ spawnError: error instanceof Error ? error.message : String(error) });
        return;
      }

      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          onAbort();
        } else {
          input.signal.addEventListener('abort', onAbort);
        }
      }

      timer = setTimeout(() => {
        timedOut = true;
        onAbort();
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
        if (input.signal?.aborted === true) {
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
