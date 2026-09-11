import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArenaRunner,
  buildSolvePrompt,
  buildWriteupMaterial,
  flagFromLog,
  targetFromQuestion,
  type ArenaProcess,
  type ArenaTarget,
} from '#/core/arena';
import type { CompetitionClient, CompetitionQuestion } from '#/core/competition';

function makeQuestion(overrides: Partial<CompetitionQuestion> = {}): CompetitionQuestion {
  return {
    questionId: 'q1',
    title: 't1',
    score: 500,
    realScore: 500,
    fileUrl: '',
    isSolved: false,
    solvedNumber: 0,
    category: 'web',
    attributes: [],
    description: 'test',
    interactive: false,
    capabilities: [],
    connection: undefined,
    extensions: {},
    ...overrides,
  };
}

function makeTarget(overrides: Partial<ArenaTarget> = {}): ArenaTarget {
  return {
    questionId: 'q1',
    title: 't1',
    category: 'web',
    score: 500,
    description: 'test',
    fileUrl: '',
    interactive: false,
    connectionUrl: undefined,
    ...overrides,
  };
}

/** 可控假进程：测试决定何时 finish / 是否停滞 */
class FakeProcess implements ArenaProcess {
  killed = false;
  readonly exited: Promise<{ code: number | null; output: string }>;
  private resolveExit!: (value: { code: number | null; output: string }) => void;
  private size = 0;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  outputSize(): number {
    return this.size;
  }

  kill(): void {
    this.killed = true;
    this.resolveExit({ code: null, output: '' });
  }

  finish(output: string, code: number | null = 0): void {
    this.size += output.length;
    this.resolveExit({ code, output });
  }
}

interface SpawnerLog {
  questionId: string;
  attempt: number;
}

function fakeSpawner() {
  const processes: FakeProcess[] = [];
  const calls: SpawnerLog[] = [];
  const spawner = (target: ArenaTarget, _dir: string, attempt: number): ArenaProcess => {
    calls.push({ questionId: target.questionId, attempt });
    const proc = new FakeProcess();
    processes.push(proc);
    return proc;
  };
  return { processes, calls, spawner };
}

/** 平台状态可变的假 client */
function fakeClient(initial: CompetitionQuestion[]) {
  const questions = initial;
  const client: CompetitionClient = {
    listQuestions: async () => questions,
  } as unknown as CompetitionClient;
  return { client, questions };
}

/** 轮询断言辅助：等到条件满足或超时 */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const FAST = { pollIntervalMs: 1, stallTimeoutMs: 60, budgetMs: 5000 };

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'misty-arena-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('flagFromLog / buildSolvePrompt / targetFromQuestion', () => {
  it('取日志中最后一个 flag 形态串', () => {
    expect(flagFromLog('x flag{first} y flag{second}')).toBe('flag{second}');
    expect(flagFromLog('no flag here')).toBeUndefined();
  });

  it('解题 prompt 含 id/分类/环境与提交指令、靶标边界', () => {
    const prompt = buildSolvePrompt(
      makeTarget({ title: 'pwn01', category: 'pwn', connectionUrl: 'nc 1.2.3.4 9999' }),
    );
    expect(prompt).toContain('questionId=q1');
    expect(prompt).toContain('nc 1.2.3.4 9999');
    expect(prompt).toContain('competition_submit');
    expect(prompt).toContain('严禁扫描或攻击任何其他主机');
  });

  it('targetFromQuestion 归一化 connection', () => {
    const target = targetFromQuestion(
      makeQuestion({ connection: { docker_ip: '10.0.0.1', docker_port: 1234 } }),
    );
    expect(target.connectionUrl).toBe('nc 10.0.0.1 1234');
  });
});

describe('ArenaRunner', () => {
  it('首尝试解出：平台 is_solved 为基准，状态/flag/状态文件齐备', async () => {
    const { questions, client } = fakeClient([makeQuestion()]);
    const { processes, calls, spawner } = fakeSpawner();
    const events: string[] = [];
    const runP = new ArenaRunner({
      client,
      spawner,
      workDir,
      targets: [makeTarget()],
      ...FAST,
      onEvent: (line) => events.push(line),
    }).run();
    await waitUntil(() => processes.length === 1);
    questions[0]!.isSolved = true;
    processes[0]!.finish('done, flag{abc-1234}');
    const summary = await runP;
    expect(summary.solved).toBe(1);
    expect(calls).toEqual([{ questionId: 'q1', attempt: 1 }]);
    expect(summary.runs[0]!.capturedFlag).toBe('flag{abc-1234}');
    const status = JSON.parse(readFileSync(join(workDir, 'arena-status.json'), 'utf8')) as {
      runs: Array<{ status: string; questionId: string }>;
    };
    expect(status.runs[0]).toMatchObject({ questionId: 'q1', status: 'solved' });
    expect(events.some((line) => line.includes('SOLVED'))).toBe(true);
  });

  it('首尝试未解出 → 带会话上下文重启一次 → 解出', async () => {
    const { questions, client } = fakeClient([makeQuestion()]);
    const { processes, calls, spawner } = fakeSpawner();
    const runP = new ArenaRunner({
      client,
      spawner,
      workDir,
      targets: [makeTarget()],
      maxAttempts: 2,
      ...FAST,
    }).run();
    await waitUntil(() => processes.length === 1);
    processes[0]!.finish('no luck'); // 未解出
    await waitUntil(() => processes.length === 2);
    questions[0]!.isSolved = true;
    processes[1]!.finish('flag{retry-ok}');
    const summary = await runP;
    expect(summary.solved).toBe(1);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
  });

  it('尝试次数耗尽 → failed', async () => {
    const { client } = fakeClient([makeQuestion()]);
    const { processes, calls, spawner } = fakeSpawner();
    const runP = new ArenaRunner({
      client,
      spawner,
      workDir,
      targets: [makeTarget()],
      maxAttempts: 2,
      ...FAST,
    }).run();
    await waitUntil(() => processes.length === 1);
    processes[0]!.finish('no');
    await waitUntil(() => processes.length === 2);
    processes[1]!.finish('no');
    const summary = await runP;
    expect(summary.failed).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('停滞看门狗：无输出超时被杀 → 重启', async () => {
    const { questions, client } = fakeClient([makeQuestion()]);
    const { processes, spawner } = fakeSpawner();
    const runP = new ArenaRunner({
      client,
      spawner,
      workDir,
      targets: [makeTarget()],
      maxAttempts: 2,
      ...FAST,
    }).run();
    await waitUntil(() => processes.length === 1);
    // 第一个进程永不产出 → stallTimeout 后被 kill
    await waitUntil(() => processes[0]!.killed, 300);
    await waitUntil(() => processes.length === 2);
    questions[0]!.isSolved = true;
    processes[1]!.finish('flag{after-stall}');
    const summary = await runP;
    expect(summary.solved).toBe(1);
    expect(processes[0]!.killed).toBe(true);
  });

  it('总预算耗尽：运行中的进程被杀，标记 abandoned', async () => {
    const { client } = fakeClient([makeQuestion()]);
    const { processes, spawner } = fakeSpawner();
    const runP = new ArenaRunner({
      client,
      spawner,
      workDir,
      targets: [makeTarget()],
      maxAttempts: 2,
      pollIntervalMs: 1,
      stallTimeoutMs: 10_000,
      budgetMs: 80,
    }).run();
    await waitUntil(() => processes.length === 1);
    const summary = await runP;
    expect(summary.abandoned).toBe(1);
    expect(processes[0]!.killed).toBe(true);
    expect(summary.runs[0]!.error).toContain('budget');
  });

  it('默认过滤已解出题；includeSolved 时纳入', async () => {
    const { client, questions } = fakeClient([
      makeQuestion({ questionId: 'solved-one', isSolved: true }),
    ]);
    const { processes, spawner } = fakeSpawner();
    const summary = await new ArenaRunner({ client, spawner, workDir, ...FAST }).run();
    expect(summary.total).toBe(0);
    expect(processes).toHaveLength(0);

    questions[0]!.isSolved = true;
    const summary2 = await new ArenaRunner({
      client,
      spawner,
      workDir,
      includeSolved: true,
      ...FAST,
    }).run();
    expect(summary2.total).toBe(1);
  });

  it('并发上限：4 题并发 2，同屏最多 2 个进程', async () => {
    const targets = [1, 2, 3, 4].map((i) => makeTarget({ questionId: `q${i}`, title: `t${i}` }));
    const questions = targets.map((t) => makeQuestion({ questionId: t.questionId, isSolved: false }));
    const { client } = fakeClient(questions);
    const { processes, spawner } = fakeSpawner();
    let running = 0;
    let maxRunning = 0;
    const trackingSpawner = (target: ArenaTarget, dir: string, attempt: number): ArenaProcess => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const proc = spawner(target, dir, attempt);
      void proc.exited.then(() => {
        running -= 1;
      });
      return proc;
    };
    const runP = new ArenaRunner({
      client,
      spawner: trackingSpawner,
      workDir,
      concurrency: 2,
      ...FAST,
    }).run();
    for (const [index, target] of targets.entries()) {
      await waitUntil(() => processes.length >= index + 1);
      const q = questions.find((question) => question.questionId === target.questionId);
      q!.isSolved = true;
      processes[index]!.finish(`flag{${target.questionId}}`);
    }
    const summary = await runP;
    expect(summary.solved).toBe(4);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('平台查询失败不判已解出，重试后失败并记录错误', async () => {
    let failPlatform = true;
    const client: CompetitionClient = {
      listQuestions: async () => {
        if (failPlatform) {
          throw new Error('platform down');
        }
        return [makeQuestion({ isSolved: true })];
      },
    } as unknown as CompetitionClient;
    const { processes, spawner } = fakeSpawner();
    const runP = new ArenaRunner({
      client,
      spawner,
      workDir,
      targets: [makeTarget()],
      maxAttempts: 2,
      ...FAST,
    }).run();
    await waitUntil(() => processes.length === 1);
    processes[0]!.finish('flag{x-1234}');
    await waitUntil(() => processes.length === 2);
    failPlatform = false;
    processes[1]!.finish('flag{x-1234}');
    const summary = await runP;
    // 第二次查询恢复，is_solved=true → solved
    expect(summary.solved).toBe(1);
    expect(summary.runs[0]!.error).toBeUndefined();
  });
});

describe('buildWriteupMaterial', () => {
  it('汇总每题状态、flag 与日志路径', () => {
    const material = buildWriteupMaterial(
      {
        startedAt: 0,
        finishedAt: 0,
        total: 1,
        solved: 1,
        failed: 0,
        abandoned: 0,
        runs: [
          {
            target: makeTarget({ title: 'web01', category: 'web' }),
            status: 'solved',
            attempt: 1,
            startedAt: 0,
            endedAt: 0,
            capturedFlag: 'flag{w-1234}',
            error: undefined,
          },
        ],
      },
      '/tmp/arena',
    );
    expect(material).toContain('web01');
    expect(material).toContain('flag{w-1234}');
    expect(material).toContain('1/1');
    expect(material).toContain(join('/tmp/arena', 'q1'));
  });
});
