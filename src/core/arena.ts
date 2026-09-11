import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompetitionClient, CompetitionQuestion } from './competition';
import { formatConnection } from './competition';

/** 解题目标：从平台赛题归一化出的调度单元 */
export interface ArenaTarget {
  questionId: string;
  title: string;
  category: string;
  score: number;
  description: string;
  fileUrl: string;
  interactive: boolean;
  connectionUrl: string | undefined;
}

export function targetFromQuestion(question: CompetitionQuestion): ArenaTarget {
  return {
    questionId: question.questionId,
    title: question.title,
    category: question.category,
    score: question.score,
    description: question.description,
    fileUrl: question.fileUrl,
    interactive: question.interactive,
    connectionUrl: formatConnection(question.connection),
  };
}

export function buildSolvePrompt(target: ArenaTarget): string {
  return [
    `你在参加 CTF 比赛（AI 智能体解题赛），请自主解出下面这道题并提交 flag。`,
    ``,
    `题目：${target.title}（question_id=${target.questionId}，分类 ${target.category}，` +
      `${target.score} 分，${target.interactive ? '容器题' : '静态题'}）`,
    `题目描述：${target.description === '' ? '（无）' : target.description}`,
    `附件下载地址：${target.fileUrl === '' ? '无' : target.fileUrl}`,
    `远程环境：${target.connectionUrl ?? '无'}`,
    ``,
    `要求：`,
    `1. 下载/分析附件与环境，挖掘漏洞并获取 flag（通常形如 flag{...}）`,
    `2. 拿到 flag 后立即用 competition_submit 工具提交（questionId=${target.questionId}）；提交正确即得分，同分比解题用时，不要拖延`,
    `3. 只允许攻击本题给定的附件与远程环境，严禁扫描或攻击任何其他主机`,
    `4. 远程 pwn 交互：本机可能没有 nc 命令，用 python socket 编程交互`,
    `5. 容器题远程环境疑似损坏（连不上/行为异常）时，可用 competition_reset 重置后重试`,
    ``,
    `最后报告：提交结果（正确/错误）、flag 内容、一句话漏洞原理。`,
  ].join('\n');
}

export type ArenaRunStatus = 'pending' | 'running' | 'solved' | 'failed' | 'abandoned';

export interface ArenaRunState {
  target: ArenaTarget;
  status: ArenaRunStatus;
  attempt: number;
  startedAt: number | undefined;
  endedAt: number | undefined;
  /** 从解题日志解析出的最后一个 flag 形态串（平台判定前仅供参考） */
  capturedFlag: string | undefined;
  error: string | undefined;
}

export interface ArenaSummary {
  startedAt: number;
  finishedAt: number;
  total: number;
  solved: number;
  failed: number;
  abandoned: number;
  runs: ArenaRunState[];
}

/** 宿主注入的解题进程；真实实现 spawn misty print 模式，测试注入假进程 */
export interface ArenaProcess {
  /** 进程退出（被 kill 也会 settle）；output 为捕获的完整 stdout */
  exited: Promise<{ code: number | null; output: string }>;
  /** 当前已产出字节数，供停滞看门狗判断 */
  outputSize(): number;
  kill(): void;
}

export type ArenaSpawner = (target: ArenaTarget, workDir: string, attempt: number) => ArenaProcess;

export interface ArenaOptions {
  client: CompetitionClient;
  spawner: ArenaSpawner;
  /** 各题工作目录的父目录（arena 自建 <workDir>/<questionId>） */
  workDir: string;
  /** 缺省由 client 拉取并过滤已解出题 */
  targets?: ArenaTarget[];
  includeSolved?: boolean;
  /** 并行解题进程数，缺省 3 */
  concurrency?: number;
  /** 每题最多尝试次数（含首发），缺省 2：失败自动带着会话上下文重跑一次 */
  maxAttempts?: number;
  /** 输出无增长判定停滞的时长，缺省 8 分钟 */
  stallTimeoutMs?: number;
  pollIntervalMs?: number;
  /** 总预算，超时杀掉全部进程收尾，缺省 28 分钟（挑战窗口 30 分钟） */
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 人类可读事件行（进度日志） */
  onEvent?: (line: string) => void;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_STALL_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BUDGET_MS = 28 * 60_000;

const FLAG_PATTERN = /flag\{[^}\s]{4,}\}/gi;

/** 取日志中最后一个 flag 形态串（最终答案通常在报告末尾） */
export function flagFromLog(log: string): string | undefined {
  const matches = log.match(FLAG_PATTERN);
  return matches === null || matches.length === 0 ? undefined : matches.at(-1);
}

interface ExitOutcome {
  code: number | null;
  output: string;
  stalled: boolean;
  budgetExhausted: boolean;
}

/**
 * 等进程退出，期间轮询 outputSize：
 * 停滞超时 → kill 后收尸（stalled）；总预算耗尽 → kill 后收尸（budgetExhausted）。
 */
async function waitForExit(
  proc: ArenaProcess,
  options: Required<Pick<ArenaOptions, 'stallTimeoutMs' | 'pollIntervalMs' | 'now' | 'sleep'>>,
  deadline: number,
): Promise<ExitOutcome> {
  const { stallTimeoutMs, pollIntervalMs, now, sleep } = options;
  let lastChangeAt = now();
  let lastSize = proc.outputSize();
  for (;;) {
    const winner = await Promise.race([
      proc.exited.then((exit) => ({ exit })),
      sleep(pollIntervalMs).then(() => ({ exit: undefined })),
    ]);
    if (winner.exit !== undefined) {
      return { ...winner.exit, stalled: false, budgetExhausted: false };
    }
    const at = now();
    const size = proc.outputSize();
    if (size !== lastSize) {
      lastSize = size;
      lastChangeAt = at;
    }
    if (at >= deadline) {
      proc.kill();
      const exit = await proc.exited;
      return { ...exit, stalled: false, budgetExhausted: true };
    }
    if (at - lastChangeAt >= stallTimeoutMs) {
      proc.kill();
      const exit = await proc.exited;
      return { ...exit, stalled: true, budgetExhausted: false };
    }
  }
}

/** 简单信号量：限制并行解题进程数 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

export class ArenaRunner {
  private readonly options: Required<
    Pick<ArenaOptions, 'concurrency' | 'maxAttempts' | 'stallTimeoutMs' | 'pollIntervalMs' | 'budgetMs' | 'now' | 'sleep'>
  >;
  private readonly client: CompetitionClient;
  private readonly spawner: ArenaSpawner;
  private readonly workDir: string;
  private readonly onEvent: (line: string) => void;
  private readonly startedAt: number;
  private readonly deadline: number;
  private readonly states = new Map<string, ArenaRunState>();

  constructor(private readonly opts: ArenaOptions) {
    this.options = {
      concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      stallTimeoutMs: opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      budgetMs: opts.budgetMs ?? DEFAULT_BUDGET_MS,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
    this.client = opts.client;
    this.spawner = opts.spawner;
    this.workDir = opts.workDir;
    this.onEvent = opts.onEvent ?? (() => {});
    this.startedAt = this.options.now();
    this.deadline = this.startedAt + this.options.budgetMs;
  }

  private log(message: string): void {
    const at = new Date(this.options.now());
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    const ss = String(at.getSeconds()).padStart(2, '0');
    this.onEvent(`[${hh}:${mm}:${ss}] ${message}`);
  }

  /** 平台 is_solved 为判题基准；查询失败返回 undefined（不视为已解出） */
  private async platformSolved(questionId: string): Promise<boolean | undefined> {
    try {
      const questions = await this.client.listQuestions();
      return questions.find((q) => q.questionId === questionId)?.isSolved;
    } catch {
      return undefined;
    }
  }

  private persist(): void {
    const runs = [...this.states.values()].map((run) => ({ ...run }));
    const payload = {
      startedAt: this.startedAt,
      finishedAt: this.options.now(),
      runs: runs.map((run) => ({
        questionId: run.target.questionId,
        title: run.target.title,
        status: run.status,
        attempt: run.attempt,
        capturedFlag: run.capturedFlag,
        error: run.error,
      })),
    };
    writeFileSync(join(this.workDir, 'arena-status.json'), `${JSON.stringify(payload, null, 2)}\n`);
  }

  private async runTarget(target: ArenaTarget, semaphore: Semaphore): Promise<void> {
    await semaphore.acquire();
    try {
      const state: ArenaRunState = {
        target,
        status: 'pending',
        attempt: 0,
        startedAt: undefined,
        endedAt: undefined,
        capturedFlag: undefined,
        error: undefined,
      };
      this.states.set(target.questionId, state);
      const dir = join(this.workDir, target.questionId);
      mkdirSync(dir, { recursive: true });

      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
        if (this.options.now() >= this.deadline) {
          state.status = 'abandoned';
          state.error = 'time budget exhausted before start';
          break;
        }
        state.status = 'running';
        state.attempt = attempt;
        state.startedAt = this.options.now();
        this.persist();
        this.log(`[${target.title}] attempt ${attempt} running`);

        const outcome = await waitForExit(
          this.spawner(target, dir, attempt),
          this.options,
          this.deadline,
        );
        state.capturedFlag = flagFromLog(outcome.output) ?? state.capturedFlag;

        if (outcome.budgetExhausted) {
          state.status = 'abandoned';
          state.error = 'time budget exhausted';
          break;
        }
        if (outcome.stalled) {
          this.log(`[${target.title}] stalled (no output), killed`);
        }

        const solved = await this.platformSolved(target.questionId);
        if (solved === true) {
          state.status = 'solved';
          state.error = undefined;
          this.log(`[${target.title}] SOLVED${state.capturedFlag === undefined ? '' : ` ${state.capturedFlag}`}`);
          break;
        }
        if (solved === undefined) {
          state.error = 'platform check unreachable';
        }
        if (attempt < this.options.maxAttempts) {
          this.log(`[${target.title}] not solved after attempt ${attempt}, restarting with session context`);
          continue;
        }
        state.status = 'failed';
        this.log(`[${target.title}] failed after ${attempt} attempt(s)`);
      }
      state.endedAt = this.options.now();
      this.persist();
    } finally {
      semaphore.release();
    }
  }

  async run(): Promise<ArenaSummary> {
    let targets = this.opts.targets;
    if (targets === undefined) {
      const questions = await this.client.listQuestions();
      const includeSolved = this.opts.includeSolved ?? false;
      targets = questions
        .filter((q) => includeSolved || !q.isSolved)
        .map(targetFromQuestion);
    }
    for (const target of targets) {
      this.log(`[${target.title}] queued (${target.category}, ${target.score}pt)`);
    }
    const semaphore = new Semaphore(this.options.concurrency);
    await Promise.all(targets.map((target) => this.runTarget(target, semaphore)));

    const runs = [...this.states.values()];
    const summary: ArenaSummary = {
      startedAt: this.startedAt,
      finishedAt: this.options.now(),
      total: runs.length,
      solved: runs.filter((r) => r.status === 'solved').length,
      failed: runs.filter((r) => r.status === 'failed').length,
      abandoned: runs.filter((r) => r.status === 'abandoned').length,
      runs,
    };
    this.log(
      `arena finished: ${summary.solved}/${summary.total} solved` +
        ` (${summary.failed} failed, ${summary.abandoned} abandoned)`,
    );
    return summary;
  }
}

/** 收尾产物：每题一节，供赛后 30 分钟内整理正式 WriteUp 使用 */
export function buildWriteupMaterial(summary: ArenaSummary, workDir: string): string {
  const lines: string[] = [
    `# WriteUp 素材（自动生成）`,
    ``,
    `生成时间：${new Date(summary.finishedAt).toISOString()}`,
    `总览：${summary.solved}/${summary.total} 解出，${summary.failed} 失败，${summary.abandoned} 超时放弃`,
    ``,
    `> 每题的完整解题过程见各题目录 run 日志：${workDir}/<question_id>/`,
    ``,
  ];
  for (const run of summary.runs) {
    const status =
      run.status === 'solved' ? '✅ 已解出' : run.status === 'failed' ? '❌ 未解出' : '⏸ 超时放弃';
    lines.push(`## ${run.target.title}（${run.target.category}，${run.target.score} 分）`);
    lines.push('');
    lines.push(`- question_id：\`${run.target.questionId}\``);
    lines.push(`- 状态：${status}（尝试 ${run.attempt} 次）`);
    if (run.capturedFlag !== undefined) {
      lines.push(`- 捕获 flag：\`${run.capturedFlag}\``);
    }
    if (run.error !== undefined) {
      lines.push(`- 异常：${run.error}`);
    }
    lines.push(`- 过程日志：\`${join(workDir, run.target.questionId)}\``);
    lines.push('');
  }
  return lines.join('\n');
}
