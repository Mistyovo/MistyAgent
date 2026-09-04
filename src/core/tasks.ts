import { exec, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** 单任务输出缓冲上限（超出丢弃头部，保留尾部） */
export const TASK_MAX_OUTPUT_CHARS = 100 * 1024;
/** 任务结束事件携带的输出尾部长度 */
export const TASK_FINISHED_TAIL_CHARS = 2000;

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed';
/** bash：shell 子进程；agent：子代理 loop（agent 工具 run_in_background） */
export type TaskKind = 'bash' | 'agent';

export interface BackgroundTask {
  /** 短 id：task_1、task_2 …递增 */
  id: string;
  kind: TaskKind;
  command: string;
  status: TaskStatus;
  /** 进程任务的 pid；agent 任务恒为 undefined */
  pid: number | undefined;
  startedAt: number;
  /** 结束时落定；信号杀死为 null */
  exitCode?: number | null | undefined;
}

export type TaskStartedCallback = (task: BackgroundTask, runningCount: number) => void;
export type TaskFinishedCallback = (
  task: BackgroundTask,
  outputTail: string,
  runningCount: number,
) => void;

/** agent 后台任务的运行句柄；子代理落定（正常结束/出错/被 stop abort）时必须调 settle */
export interface AgentTaskHandle {
  /** 启动时刻的任务快照 */
  task: BackgroundTask;
  /** 停止信号：task_stop 触发 abort，子代理 loop 级联中断 */
  signal: AbortSignal;
  /** 追加中间输出（流式文本、工具调用摘要行），环形截断与进程任务一致 */
  appendOutput: (text: string) => void;
  /** 落定任务：0 → completed，非 0 → failed；stop 已发起时一律记 killed */
  settle: (exitCode: number) => void;
}

/** 两种任务形态的差异收敛在 terminate：进程杀进程树，agent abort 信号 */
interface TaskHandle {
  pid: number | undefined;
  terminate: () => Promise<void>;
}

interface TrackedTask {
  snapshot: BackgroundTask;
  handle: TaskHandle;
  output: string;
  /** stop 主动发起过终止：落定后状态记 killed 而不是 failed */
  killRequested: boolean;
  waiters: Array<() => void>;
}

/**
 * 后台任务管理器（对标 Claude Code Bash run_in_background + TaskOutput/TaskStop），
 * 承载两种任务：bash 子进程与 agent 子代理 loop。
 * spawn(command, { shell: true }) 与 bash 工具前台路径同属 cmd.exe / sh 语义；
 * 任务不绑定 turn 的 AbortSignal——interrupt / turn 结束不影响后台任务。
 *
 * Windows 杀进程树：taskkill /pid <pid> /t /f（child.kill 只杀壳层 cmd.exe，
 * 子进程会成孤儿）；失败兜底 child.kill()。POSIX：detached 使子进程成为
 * 进程组组长，负 pid 向整组发 SIGTERM，500ms 未退出升级 SIGKILL。
 */
export class TaskManager {
  private readonly tasks = new Map<string, TrackedTask>();
  private counter = 0;
  private readonly startedCallbacks = new Set<TaskStartedCallback>();
  private readonly finishedCallbacks = new Set<TaskFinishedCallback>();

  onStarted(callback: TaskStartedCallback): () => void {
    this.startedCallbacks.add(callback);
    return () => {
      this.startedCallbacks.delete(callback);
    };
  }

  onFinished(callback: TaskFinishedCallback): () => void {
    this.finishedCallbacks.add(callback);
    return () => {
      this.finishedCallbacks.delete(callback);
    };
  }

  start(command: string, cwd: string): BackgroundTask {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle: TaskHandle = { pid: child.pid, terminate: () => Promise.resolve() };
    const tracked = this.register('bash', command, handle);
    // terminate 需要任务 id（POSIX 升级 SIGKILL 前按 id 查状态），注册后回填
    handle.terminate = () => this.killTree(tracked.snapshot.id, child);
    child.stdout?.on('data', (chunk: Buffer) => {
      this.appendOutput(tracked, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendOutput(tracked, chunk.toString('utf8'));
    });
    // spawn 失败（如 cwd 不存在）：error 后不一定有 close，两条路径都要能落定
    child.on('error', (error) => {
      this.appendOutput(tracked, `[spawn 失败] ${error.message}`);
      this.settle(tracked, null);
    });
    // 等 close 而不是 exit：stdio 冲刷完毕后输出缓冲才完整
    child.on('close', (code) => {
      this.settle(tracked, code);
    });
    return { ...tracked.snapshot };
  }

  /** 登记 agent 子代理任务；调用方持有句柄推进输出与落定，任务事件与进程任务同通道 */
  startAgent(command: string): AgentTaskHandle {
    const controller = new AbortController();
    const tracked = this.register('agent', command, {
      pid: undefined,
      terminate: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    return {
      task: { ...tracked.snapshot },
      signal: controller.signal,
      appendOutput: (text) => {
        this.appendOutput(tracked, text);
      },
      settle: (exitCode) => {
        this.settle(tracked, exitCode);
      },
    };
  }

  /** 当前输出缓冲（最多保留尾部 TASK_MAX_OUTPUT_CHARS 字符）；任务不存在返回 null */
  output(taskId: string): { task: BackgroundTask; output: string } | null {
    const tracked = this.tasks.get(taskId);
    if (tracked === undefined) {
      return null;
    }
    return { task: { ...tracked.snapshot }, output: tracked.output };
  }

  get(taskId: string): BackgroundTask | null {
    const tracked = this.tasks.get(taskId);
    return tracked === undefined ? null : { ...tracked.snapshot };
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()].map((tracked) => ({ ...tracked.snapshot }));
  }

  runningCount(): number {
    return this.list().filter((task) => task.status === 'running').length;
  }

  /** 等到任务结束或超时（timeoutMs 到达后返回当前快照，不代表已结束） */
  waitForSettled(taskId: string, timeoutMs: number): Promise<BackgroundTask | null> {
    const tracked = this.tasks.get(taskId);
    if (tracked === undefined) {
      return Promise.resolve(null);
    }
    if (tracked.snapshot.status !== 'running') {
      return Promise.resolve({ ...tracked.snapshot });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ...tracked.snapshot });
      }, timeoutMs);
      tracked.waiters.push(() => {
        clearTimeout(timer);
        resolve({ ...tracked.snapshot });
      });
    });
  }

  /** 终止任务并等落定；任务不存在返回 null，已结束则直接返回当前快照 */
  async stop(taskId: string): Promise<BackgroundTask | null> {
    const tracked = this.tasks.get(taskId);
    if (tracked === undefined) {
      return null;
    }
    if (tracked.snapshot.status === 'running') {
      tracked.killRequested = true;
      await tracked.handle.terminate();
      // taskkill/SIGKILL 后 close 应立即到达；agent abort 后子 loop 同理。兜底再等 5s：
      // 仍未落定（回调丢失/子 loop 卡在不可中断点）则强制按 killed 落定
      await this.waitForSettled(taskId, 5000);
      if (tracked.snapshot.status === 'running') {
        this.settle(tracked, null);
      }
    }
    return { ...tracked.snapshot };
  }

  private register(kind: TaskKind, command: string, handle: TaskHandle): TrackedTask {
    const id = `task_${(this.counter += 1)}`;
    const tracked: TrackedTask = {
      snapshot: { id, kind, command, status: 'running', pid: handle.pid, startedAt: Date.now() },
      handle,
      output: '',
      killRequested: false,
      waiters: [],
    };
    this.tasks.set(id, tracked);
    for (const callback of this.startedCallbacks) {
      callback({ ...tracked.snapshot }, this.runningCount());
    }
    return tracked;
  }

  private appendOutput(tracked: TrackedTask, text: string): void {
    tracked.output += text;
    if (tracked.output.length > TASK_MAX_OUTPUT_CHARS) {
      tracked.output = tracked.output.slice(-TASK_MAX_OUTPUT_CHARS);
    }
  }

  private settle(tracked: TrackedTask, code: number | null): void {
    if (tracked.snapshot.status !== 'running') {
      return;
    }
    tracked.snapshot.exitCode = code;
    tracked.snapshot.status = tracked.killRequested ? 'killed' : code === 0 ? 'completed' : 'failed';
    const waiters = tracked.waiters.splice(0);
    for (const notify of waiters) {
      notify();
    }
    const tail = tracked.output.slice(-TASK_FINISHED_TAIL_CHARS);
    const snapshot = { ...tracked.snapshot };
    const runningCount = this.runningCount();
    for (const callback of this.finishedCallbacks) {
      callback(snapshot, tail, runningCount);
    }
  }

  private async killTree(id: string, child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (process.platform === 'win32') {
      if (pid !== undefined) {
        try {
          await execAsync(`taskkill /pid ${pid} /t /f`);
          return;
        } catch {
          // 进程可能刚好已退出；兜底 child.kill
        }
      }
      child.kill();
      return;
    }
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (pid !== undefined) {
          process.kill(-pid, signal);
          return;
        }
      } catch {
        // 组已不存在，退化为只杀壳进程
      }
      child.kill(signal);
    };
    killGroup('SIGTERM');
    await this.waitForSettled(id, 500);
    if (this.tasks.get(id)?.snapshot.status === 'running') {
      killGroup('SIGKILL');
    }
  }
}
