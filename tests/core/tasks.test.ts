import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '#/core/events';
import { evaluatePermission, createPermissionRuntime } from '#/core/permission/pipeline';
import { Session } from '#/core/session/session';
import { TaskManager, TASK_MAX_OUTPUT_CHARS } from '#/core/tasks';
import { createBashTool } from '#/core/tools/builtin/bash';
import { createBuiltinRegistry } from '#/core/tools/builtin/index';
import {
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
} from '#/core/tools/builtin/tasks';
import type { ToolContext } from '#/core/tools/tool';
import type { ChatProvider } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

/** 测试创建的 TaskManager 统一登记，afterEach 杀残留进程防泄漏 */
const managers: TaskManager[] = [];

function makeManager(): TaskManager {
  const manager = new TaskManager();
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const task of manager.list()) {
      if (task.status === 'running') {
        await manager.stop(task.id);
      }
    }
  }
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor 超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const LONG_RUNNING = 'node -e "setInterval(()=>{}, 5000)"';

describe('TaskManager', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'misty-tasks-'));
  });

  it('start 立即返回递增短 id，状态 running；echo 落定 completed 且捕获输出', async () => {
    const manager = makeManager();
    const first = manager.start('echo hello-bg', cwd);
    const second = manager.start('echo second', cwd);
    expect(first.id).toBe('task_1');
    expect(second.id).toBe('task_2');
    expect(first.status).toBe('running');
    expect(first.pid).toBeTypeOf('number');

    const settled = await manager.waitForSettled(first.id, 5000);
    expect(settled).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(manager.output(first.id)?.output).toContain('hello-bg');
    expect(manager.runningCount()).toBeLessThanOrEqual(1);
  }, 15000);

  it('非零退出码 → failed，exitCode 落定', async () => {
    const manager = makeManager();
    const task = manager.start('exit 3', cwd);
    const settled = await manager.waitForSettled(task.id, 5000);
    expect(settled).toMatchObject({ status: 'failed', exitCode: 3 });
  }, 15000);

  it('stop 杀进程树：长任务连同孙进程一起终止，状态 killed（Windows 实测 taskkill /t /f）', async () => {
    const manager = makeManager();
    // node 孙进程打印自己的 pid，之后校验它确实死了（不只 cmd 壳死了）
    const task = manager.start(
      'node -e "console.log(\'childpid:\'+process.pid); setInterval(()=>{}, 500)"',
      cwd,
    );
    await waitFor(() => manager.output(task.id)?.output.includes('childpid:') === true);
    const match = /childpid:(\d+)/.exec(manager.output(task.id)!.output);
    const grandchildPid = Number(match![1]);

    const stopped = await manager.stop(task.id);
    expect(stopped).toMatchObject({ status: 'killed' });
    expect(() => process.kill(grandchildPid, 0)).toThrow();
    expect(manager.runningCount()).toBe(0);
  }, 15000);

  it('输出缓冲环形截断：超过上限只保留尾部', async () => {
    const manager = makeManager();
    const size = TASK_MAX_OUTPUT_CHARS + 50_000;
    const task = manager.start(`node -e "process.stdout.write('x'.repeat(${size}))"`, cwd);
    await manager.waitForSettled(task.id, 10_000);
    const output = manager.output(task.id)!.output;
    expect(output.length).toBeLessThanOrEqual(TASK_MAX_OUTPUT_CHARS);
    expect(output.length).toBeGreaterThan(TASK_MAX_OUTPUT_CHARS - 10_000);
    expect(/^[x\n]+$/.test(output)).toBe(true);
  }, 15000);

  it('waitForSettled 超时返回当前 running 快照，不阻塞', async () => {
    const manager = makeManager();
    const task = manager.start(LONG_RUNNING, cwd);
    const start = Date.now();
    const snapshot = await manager.waitForSettled(task.id, 150);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(snapshot?.status).toBe('running');
  }, 15000);

  it('onStarted / onFinished 回调携带快照、输出尾部与 runningCount', async () => {
    const manager = makeManager();
    const started: string[] = [];
    const finished: { id: string; status: string; tail: string; runningCount: number }[] = [];
    manager.onStarted((task, runningCount) => {
      started.push(`${task.id}:${runningCount}`);
    });
    manager.onFinished((task, outputTail, runningCount) => {
      finished.push({ id: task.id, status: task.status, tail: outputTail, runningCount });
    });

    const task = manager.start('echo cb-output', cwd);
    expect(started).toEqual(['task_1:1']);
    await manager.waitForSettled(task.id, 5000);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ id: 'task_1', status: 'completed', runningCount: 0 });
    expect(finished[0]!.tail).toContain('cb-output');
  }, 15000);

  it('output / get / stop 对未知 id 返回 null', async () => {
    const manager = makeManager();
    expect(manager.output('task_99')).toBeNull();
    expect(manager.get('task_99')).toBeNull();
    await expect(manager.stop('task_99')).resolves.toBeNull();
    await expect(manager.waitForSettled('task_99', 10)).resolves.toBeNull();
  });
});

describe('task 工具组', () => {
  let cwd: string;
  let ctx: ToolContext;
  let manager: TaskManager;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'misty-tasktools-'));
    ctx = { cwd, signal: new AbortController().signal };
    manager = makeManager();
  });

  it('bash run_in_background 立即返回 taskId，不等待命令结束', async () => {
    const bash = createBashTool(manager);
    const start = Date.now();
    const result = await bash.call(
      { command: LONG_RUNNING, run_in_background: true },
      ctx,
    );
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('task_1');
    expect(manager.get('task_1')?.status).toBe('running');
    expect(bash.describeCall({ command: LONG_RUNNING, run_in_background: true })).toContain(
      'Bash(后台)',
    );
  }, 15000);

  it('task_output 非阻塞返回当前状态与输出；未知任务 isError', async () => {
    const output = createTaskOutputTool(manager);
    manager.start('echo out-check', cwd);
    const result = await output.call({ taskId: 'task_1' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('task_1 [');

    const missing = await output.call({ taskId: 'task_42' }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('task_42');
    expect(output.isReadOnly({ taskId: 'task_1' })).toBe(true);
  }, 15000);

  it('task_output block=true 等到任务结束拿到最终输出', async () => {
    const output = createTaskOutputTool(manager);
    manager.start('node -e "setTimeout(()=>console.log(\'late-out\'), 300)"', cwd);
    const result = await output.call({ taskId: 'task_1', block: true, timeoutMs: 5000 }, ctx);
    expect(result.output).toContain('completed');
    expect(result.output).toContain('late-out');
  }, 15000);

  it('task_output block=true 超时返回 running 快照', async () => {
    const output = createTaskOutputTool(manager);
    manager.start(LONG_RUNNING, cwd);
    const start = Date.now();
    const result = await output.call({ taskId: 'task_1', block: true, timeoutMs: 200 }, ctx);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(result.output).toContain('[bash:running]');
  }, 15000);

  it('task_stop 终止任务并返回最终状态；重复 stop 报告已结束', async () => {
    const stop = createTaskStopTool(manager);
    manager.start(LONG_RUNNING, cwd);
    const result = await stop.call({ taskId: 'task_1' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('killed');
    expect(manager.get('task_1')?.status).toBe('killed');

    const again = await stop.call({ taskId: 'task_1' }, ctx);
    expect(again.output).toContain('已结束');

    const missing = await stop.call({ taskId: 'task_9' }, ctx);
    expect(missing.isError).toBe(true);
  }, 15000);

  it('task_stop 声明 execute 访问，default 权限模式走审批', () => {
    const stop = createTaskStopTool(manager);
    expect(stop.accesses({ taskId: 'task_1' })).toEqual([{ kind: 'execute' }]);
    const runtime = createPermissionRuntime({ mode: 'default', cwd });
    const decision = evaluatePermission(stop, { taskId: 'task_1' }, runtime.getContext());
    expect(decision.kind).toBe('ask');
  });

  it('task_list 空列表与各状态任务', async () => {
    const list = createTaskListTool(manager);
    expect((await list.call({}, ctx)).output).toBe('没有后台任务');

    manager.start('echo list-check', cwd);
    manager.start(LONG_RUNNING, cwd);
    await waitFor(() => manager.get('task_1')?.status === 'completed');
    const result = await list.call({}, ctx);
    expect(result.output).toContain('task_1  bash:completed (exit 0)  echo list-check');
    expect(result.output).toMatch(/task_2 {2}bash:running \(pid \d+\)/);
  }, 15000);
});

describe('TaskManager agent 任务', () => {
  it('startAgent 登记 agent 任务：无 pid，句柄推进输出与落定，完成事件同通道', async () => {
    const manager = makeManager();
    const finished: { id: string; status: string; tail: string; runningCount: number }[] = [];
    manager.onFinished((task, tail, runningCount) => {
      finished.push({ id: task.id, status: task.status, tail, runningCount });
    });

    const handle = manager.startAgent('Agent(explore) 找 foo');
    expect(handle.task).toMatchObject({
      id: 'task_1',
      kind: 'agent',
      status: 'running',
      pid: undefined,
    });
    handle.appendOutput('中间文本');
    handle.settle(0);

    expect(manager.get('task_1')).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(manager.output('task_1')?.output).toContain('中间文本');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ id: 'task_1', status: 'completed', runningCount: 0 });
    expect(finished[0]!.tail).toContain('中间文本');
  });

  it('stop 触发 abort 信号并按 killed 落定；迟到的重复 settle 幂等', async () => {
    const manager = makeManager();
    const handle = manager.startAgent('Agent(plan) 规划');
    let aborted = false;
    handle.signal.addEventListener(
      'abort',
      () => {
        aborted = true;
        // 模拟子代理 loop 响应 abort 后落定
        handle.settle(1);
      },
      { once: true },
    );

    const stopped = await manager.stop('task_1');
    expect(aborted).toBe(true);
    expect(stopped).toMatchObject({ status: 'killed' });
    handle.settle(0);
    expect(manager.get('task_1')?.status).toBe('killed');
  });
});

describe('后台任务 loop 集成', () => {
  it('fake provider 驱动"后台启动→结束"：Session 派发 task-started 与 task-finished', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'misty-taskloop-'));
    const manager = makeManager();
    const registry = createBuiltinRegistry({ taskManager: manager });
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'bash',
          arguments: JSON.stringify({ command: 'echo loop-bg', run_in_background: true }),
        },
      ]),
      textStep('已启动'),
    ]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd,
      permission: { mode: 'bypassPermissions' },
      tasks: manager,
    });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const result = await session.submit({ type: 'user-turn', text: 'go' });
    expect(result.stopReason).toBe('completed');

    const taskId = manager.list()[0]!.id;
    const started = events.find((e) => e.type === 'task-started');
    expect(started).toMatchObject({ type: 'task-started', taskId, runningCount: 1 });

    await manager.waitForSettled(taskId, 5000);
    const finished = events.find((e) => e.type === 'task-finished');
    expect(finished).toMatchObject({
      type: 'task-finished',
      taskId,
      status: 'completed',
      exitCode: 0,
      runningCount: 0,
    });
    expect(finished?.type === 'task-finished' && finished.outputTail).toContain('loop-bg');
  }, 15000);

  it('agent run_in_background：主 turn 拿到 taskId，Session 派发 task-started / task-finished', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'misty-agentloop-'));
    const manager = makeManager();
    const main = new FakeProvider([
      toolCallStep([
        {
          name: 'agent',
          arguments: JSON.stringify({
            description: '后台找 foo',
            prompt: 'foo 定义在哪里？',
            subagent_type: 'explore',
            run_in_background: true,
          }),
        },
      ]),
      textStep('已启动后台子代理'),
    ]);
    const sub = new FakeProvider([textStep('子代理结论：foo 在 a.ts:1')]);
    // 主会话与子代理共享连接场景的路由：按 system prompt 区分脚本，消除消费顺序竞争
    const router: ChatProvider = {
      generate: (params) =>
        params.systemPrompt.includes('代码探索子代理')
          ? sub.generate(params)
          : main.generate(params),
    };
    const registry = createBuiltinRegistry({
      taskManager: manager,
      provider: router,
      getModel: () => 'fake-model',
    });
    const session = new Session({
      provider: router,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd,
      permission: { mode: 'bypassPermissions' },
      tasks: manager,
    });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const result = await session.submit({ type: 'user-turn', text: 'go' });
    expect(result.stopReason).toBe('completed');
    // 主 turn 拿到了后台 taskId 回执
    const toolMessage = session
      .getMessages()
      .find((m) => m.role === 'tool' && m.name === 'agent');
    expect(toolMessage?.content).toContain('task_1');

    expect(events.find((e) => e.type === 'task-started')).toMatchObject({
      type: 'task-started',
      taskId: 'task_1',
      command: 'Agent(explore) 后台找 foo',
      pid: undefined,
    });

    await manager.waitForSettled('task_1', 5000);
    const finished = events.find((e) => e.type === 'task-finished');
    expect(finished).toMatchObject({
      type: 'task-finished',
      taskId: 'task_1',
      status: 'completed',
      exitCode: 0,
      runningCount: 0,
    });
    expect(finished?.type === 'task-finished' && finished.outputTail).toContain(
      '子代理结论：foo 在 a.ts:1',
    );
  }, 15000);
});

describe('TaskManager 输出分段缓冲', () => {
  it('高频小 chunk 追加：截断语义不变，与整段写入只留尾部上限逐字节一致', () => {
    const manager = makeManager();
    const handle = manager.startAgent('agent 高频输出');
    const totalChunks = 20_000;
    const chunks: string[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = `line-${i}\n`;
      chunks.push(chunk);
      handle.appendOutput(chunk);
    }
    const output = manager.output(handle.task.id)!.output;
    expect(output.length).toBeLessThanOrEqual(TASK_MAX_OUTPUT_CHARS);
    expect(output.endsWith(`line-${totalChunks - 1}\n`)).toBe(true);
    expect(output).not.toContain('line-0\n');
    expect(output).toBe(chunks.join('').slice(-TASK_MAX_OUTPUT_CHARS));
    handle.settle(0);
  });

  it('读取时拼接物化：多次读取结果一致，落定 tail 与当前输出一致', () => {
    const manager = makeManager();
    const tails: string[] = [];
    manager.onFinished((_task, tail) => {
      tails.push(tail);
    });
    const handle = manager.startAgent('agent 分段读取');
    handle.appendOutput('aaa');
    handle.appendOutput('bbb');
    expect(manager.output(handle.task.id)!.output).toBe('aaabbb');
    expect(manager.output(handle.task.id)!.output).toBe('aaabbb');
    handle.appendOutput('ccc');
    expect(manager.output(handle.task.id)!.output).toBe('aaabbbccc');
    handle.settle(0);
    expect(tails).toEqual(['aaabbbccc']);
  });
});
