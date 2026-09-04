import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runPrintMode } from '#/cli/print-mode';
import { Session } from '#/core/session/session';
import { TaskManager } from '#/core/tasks';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { ToolRegistry } from '#/core/tools/registry';
import { defineTool } from '#/core/tools/tool';
import type { StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from '../core/fake-provider';

function fakeStream(): { stream: Writable; text: () => string } {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  return { stream, text: () => data };
}

async function run(scripts: StreamedMessagePart[][]) {
  const provider = new FakeProvider(scripts);
  const registry = createBuiltinRegistry();
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: registry.list(),
    cwd: process.cwd(),
  });
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await runPrintMode({
    session,
    registry,
    prompt: 'go',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('runPrintMode', () => {
  it('completed：文本流式进 stdout（补尾换行），stderr 干净，退出码 0', async () => {
    const { code, stdout, stderr } = await run([textStep('你好，世界')]);
    expect(code).toBe(0);
    expect(stdout).toBe('你好，世界\n');
    expect(stderr).toBe('');
  });

  it('工具被拒执行：审批请求自动拒绝并回喂，完成摘要进 stderr（无 ⏵ 启动行）', async () => {
    const { code, stdout, stderr } = await run([
      toolCallStep([{ name: 'bash', arguments: '{"command":"echo hi"}' }]),
      textStep('收尾'),
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe('收尾\n');
    expect(stderr).not.toContain('⏵');
    expect(stderr).toContain('无头模式无法交互审批，已自动拒绝：Bash echo hi');
    expect(stderr).toMatch(/✗ Bash echo hi（\d+ms）/);
  });

  it('只读工具放行执行：stderr 依次出现 ⏵ 启动行与 ✓ 完成行', async () => {
    const fakeRead = defineTool({
      name: 'fake_read',
      description: 'test',
      inputSchema: z.object({}),
      isReadOnly: () => true,
      describeCall: () => 'FakeRead',
      call: async () => ({ output: 'fake-output' }),
    });
    const provider = new FakeProvider([
      toolCallStep([{ name: 'fake_read', arguments: '{}' }]),
      textStep('收尾'),
    ]);
    const registry = new ToolRegistry();
    registry.register(fakeRead);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
    });
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await runPrintMode({
      session,
      registry,
      prompt: 'go',
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toBe('收尾\n');
    expect(stderr.text()).toMatch(/⏵ FakeRead\n✓ FakeRead（\d+ms）\n/);
  });

  it('无头模式提问：ask_user 直接回喂自行决策，不挂起不弹审批', async () => {
    const { code, stdout, stderr } = await run([
      toolCallStep([
        {
          name: 'ask_user',
          arguments: '{"question":"选哪个方案？","options":[{"label":"甲"},{"label":"乙"}]}',
        },
      ]),
      textStep('自行决策收尾'),
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe('自行决策收尾\n');
    // 交互型工具权限直接放行：不出现审批拒绝行；工具完成行带 ✗（无头回喂是 isError）
    expect(stderr).not.toContain('无头模式无法交互审批');
    expect(stderr).toMatch(/✗ Ask: 选哪个方案？（\d+ms）/);
  });

  it('error：错误写 stderr，退出码 1', async () => {
    const { code, stderr } = await run([[{ type: 'error', error: new Error('boom') }]]);
    expect(code).toBe(1);
    expect(stderr).toContain('✗ boom');
  });

  it('无头模式计划批准：plan-approval-requested 自动拒绝并回喂说明', async () => {
    // 与 main.ts 相同的接线：plan 工具经 sessionRef 闭包拿 Session 的计划模式能力
    let sessionRef: Session | null = null;
    const registry = createBuiltinRegistry({
      planMode: {
        isPlanMode: () => sessionRef?.isPlanMode() ?? false,
        enterPlanMode: () => sessionRef?.enterPlanMode() ?? false,
        exitPlanMode: (target) => sessionRef?.exitPlanMode(target) ?? false,
        requestPlanApproval: (request, signal) =>
          sessionRef?.requestPlanApproval(request, signal) ??
          Promise.resolve({ approved: false, feedback: '会话尚未就绪' }),
      },
    });
    const provider = new FakeProvider([
      toolCallStep([{ name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 计划' }) }]),
      textStep('以文本输出计划'),
    ]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
      permission: { mode: 'plan' },
    });
    sessionRef = session;
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await runPrintMode({
      session,
      registry,
      prompt: 'go',
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toBe('以文本输出计划\n');
    expect(stderr.text()).toContain('无头模式无法交互批准计划');
    const toolMessage = session.getMessages().find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ name: 'exit_plan_mode', isError: true });
    expect(toolMessage?.role === 'tool' && toolMessage.content).toContain('计划被拒绝');
    expect(toolMessage?.role === 'tool' && toolMessage.content).toContain('无头');
    // 自动拒绝不退出计划模式
    expect(session.isPlanMode()).toBe(true);
  });
});

describe('runPrintMode 后台任务 drain', () => {
  it('turn 结束后仍有 running 任务：至多等 3s 后终止，防进程挂住', async () => {
    const tasks = new TaskManager();
    const registry = createBuiltinRegistry({ taskManager: tasks });
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'bash',
          arguments: JSON.stringify({
            command: 'node -e "setInterval(()=>{}, 30000)"',
            run_in_background: true,
          }),
        },
      ]),
      textStep('已后台启动'),
    ]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
      permission: { mode: 'bypassPermissions' },
      tasks,
    });
    const stdout = fakeStream();
    const stderr = fakeStream();
    const start = Date.now();
    const code = await runPrintMode({
      session,
      registry,
      prompt: 'go',
      tasks,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toBe('已后台启动\n');
    // drain 等待约 3s 后终止任务（不是无限挂起，也不是立即杀死）
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(8000);
    expect(stderr.text()).toContain('还有 1 个后台任务在运行');
    expect(stderr.text()).toContain('未在等待期内结束，已终止');
    expect(tasks.list()[0]?.status).toBe('killed');
  }, 15000);

  it('后台任务在 turn 内结束：task-finished 写 stderr，drain 不再等待', async () => {
    const tasks = new TaskManager();
    const registry = createBuiltinRegistry({ taskManager: tasks });
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'bash',
          arguments: JSON.stringify({ command: 'echo print-bg', run_in_background: true }),
        },
      ]),
      // 阻塞等 echo 落定，保证 turn 结束时任务已完成（消除与 drain 的竞态）
      toolCallStep([
        {
          name: 'task_output',
          arguments: JSON.stringify({ taskId: 'task_1', block: true, timeoutMs: 5000 }),
        },
      ]),
      textStep('收尾'),
    ]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
      permission: { mode: 'bypassPermissions' },
      tasks,
    });
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await runPrintMode({
      session,
      registry,
      prompt: 'go',
      tasks,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    // echo 在 drain 前已完成：没有"等待/终止"提示
    expect(stderr.text()).not.toContain('后台任务在运行');
    expect(stderr.text()).toMatch(/⚙ task_1 已完成（exit 0）/);
  }, 15000);
});
