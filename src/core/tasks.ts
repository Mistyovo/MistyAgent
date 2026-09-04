import { exec, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** 单任务 stdout+stderr 合并缓冲上限（超出丢弃头部，保留尾部） */
export const TASK_MAX_OUTPUT_CHARS = 100 * 1024;
/** 任务结束事件携带的输出尾部长度 */
export const TASK_FINISHED_TAIL_CHARS = 2000;

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface BackgroundTask {
  /** 短 id：task_1、task_2 …递增 */
  id: string;
  command: string;
  status: TaskStatus;
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

interface TrackedTask {
  snapshot: BackgroundTask;
  child: ChildProcess;
  output: string;
  /** stop 主动发起过 kill：close 后状态记 killed 而不是 failed */
  killRequested: boolean;
  waiters: Array<() => void>;
}

/**
 * 后台任务管理器（对标 Claude Code Bash run_in_background + TaskOutput/TaskStop）。
 * spawn(command, { shell: true }) 与 bash 工具前台路径同属 cmd.exe / sh 语义；
 * 任务不绑定 turn 的 AbortSignal——interrupt / turn 结束不影响后台进程。
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
    const id = `task_${(this.counter += 1)}`;
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tracked: TrackedTask = {
      snapshot: { id, command, status: 'running', pid: child.pid, startedAt: Date.now() },
      child,
      output: '',
      killRequested: false,
      waiters: [],
    };
    this.tasks.set(id, tracked);
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
    for (const callback of this.startedCallbacks) {
      callback({ ...tracked.snapshot }, this.runningCount());
    }
    return { ...tracked.snapshot };
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

  /** 杀进程树并等落定；任务不存在返回 null，已结束则直接返回当前快照 */
  async stop(taskId: string): Promise<BackgroundTask | null> {
    const tracked = this.tasks.get(taskId);
    if (tracked === undefined) {
      return null;
    }
    if (tracked.snapshot.status === 'running') {
      tracked.killRequested = true;
      await this.killTree(tracked);
      // taskkill/SIGKILL 后 close 应立即到达；兜底再等 5s 防回调丢失
      await this.waitForSettled(taskId, 5000);
    }
    return { ...tracked.snapshot };
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

  private async killTree(tracked: TrackedTask): Promise<void> {
    const pid = tracked.child.pid;
    if (process.platform === 'win32') {
      if (pid !== undefined) {
        try {
          await execAsync(`taskkill /pid ${pid} /t /f`);
          return;
        } catch {
          // 进程可能刚好已退出；兜底 child.kill
        }
      }
      tracked.child.kill();
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
      tracked.child.kill(signal);
    };
    killGroup('SIGTERM');
    await this.waitForSettled(tracked.snapshot.id, 500);
    if (tracked.snapshot.status === 'running') {
      killGroup('SIGKILL');
    }
  }
}
