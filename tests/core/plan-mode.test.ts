import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PermissionRule } from '#/config/schema';
import type {
  AgentEvent,
  PlanApprovalRequestedEvent,
  PlanModeChangedEvent,
} from '#/core/events';
import { evaluatePermission, type PermissionContext } from '#/core/permission/pipeline';
import {
  PlanApprovalManager,
  buildPlanModePrompt,
  type PlanApprovalRequest,
  type PlanModeHost,
} from '#/core/plan-mode';
import { Session, type SessionConfig } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
} from '#/core/tools/builtin/plan-mode';
import type { ToolContext } from '#/core/tools/tool';
import type { AssistantMessage, ToolMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

const ctx: ToolContext = { cwd, signal: new AbortController().signal };

const planRequest: PlanApprovalRequest = { id: 'p1', plan: '# 计划\n1. 第一步' };

function planModeEvents(session: Session): PlanModeChangedEvent[] {
  const events: PlanModeChangedEvent[] = [];
  session.onEvent((event) => {
    if (event.type === 'plan-mode-changed') {
      events.push(event);
    }
  });
  return events;
}

function planApprovals(events: AgentEvent[]): PlanApprovalRequestedEvent[] {
  return events.filter(
    (e): e is PlanApprovalRequestedEvent => e.type === 'plan-approval-requested',
  );
}

describe('PlanApprovalManager', () => {
  it('request 挂起，reply approved 兑现', async () => {
    const manager = new PlanApprovalManager();
    const promise = manager.request(planRequest);
    expect(manager.pendingCount).toBe(1);
    expect(manager.reply('p1', { approved: true })).toBe(true);
    await expect(promise).resolves.toEqual({ approved: true });
    expect(manager.pendingCount).toBe(0);
  });

  it('reply 未知 id 返回 false', () => {
    const manager = new PlanApprovalManager();
    expect(manager.reply('nope', { approved: true })).toBe(false);
  });

  it('重复 id 的 request 立即落定拒绝，不影响在途挂起', async () => {
    const manager = new PlanApprovalManager();
    const first = manager.request(planRequest);
    const dup = await manager.request(planRequest);
    expect(dup.approved).toBe(false);
    expect(dup.feedback).toContain('重复');
    expect(manager.reply('p1', { approved: true })).toBe(true);
    await expect(first).resolves.toEqual({ approved: true });
  });

  it('cancelAll 落定所有挂起为拒绝（interrupted）', async () => {
    const manager = new PlanApprovalManager();
    const a = manager.request(planRequest);
    const b = manager.request({ ...planRequest, id: 'p2' });
    expect(manager.pendingCount).toBe(2);
    manager.cancelAll();
    await expect(a).resolves.toEqual({ approved: false, feedback: 'interrupted by user' });
    await expect(b).resolves.toEqual({ approved: false, feedback: 'interrupted by user' });
    expect(manager.pendingCount).toBe(0);
  });

  it('signal 已 abort：request 立即拒绝，不发 onRequested 通知', async () => {
    const manager = new PlanApprovalManager();
    const onRequested = vi.fn();
    manager.onRequested(onRequested);
    const controller = new AbortController();
    controller.abort();
    const reply = await manager.request(planRequest, controller.signal);
    expect(reply.approved).toBe(false);
    expect(onRequested).not.toHaveBeenCalled();
    expect(manager.pendingCount).toBe(0);
  });

  it('request 后 signal abort：落定拒绝，迟到的 reply 返回 false', async () => {
    const manager = new PlanApprovalManager();
    const controller = new AbortController();
    const promise = manager.request(planRequest, controller.signal);
    controller.abort();
    await expect(promise).resolves.toEqual({ approved: false, feedback: 'interrupted by user' });
    expect(manager.pendingCount).toBe(0);
    expect(manager.reply('p1', { approved: true })).toBe(false);
  });

  it('先挂起再通知：监听器在 onRequested 回调里同步回复也能兑现', async () => {
    const manager = new PlanApprovalManager();
    const seen: PlanApprovalRequest[] = [];
    manager.onRequested((req) => {
      seen.push(req);
      manager.reply(req.id, { approved: false, feedback: '再想想' });
    });
    await expect(manager.request(planRequest)).resolves.toEqual({
      approved: false,
      feedback: '再想想',
    });
    expect(seen).toEqual([planRequest]);
    expect(manager.pendingCount).toBe(0);
  });
});

describe('Session 计划模式状态机', () => {
  function bareSession(mode?: 'default' | 'plan'): Session {
    return new Session({
      provider: new FakeProvider([]),
      model: 'fake-model',
      systemPrompt: 'system',
      tools: [],
      cwd,
      ...(mode === undefined ? {} : { permission: { mode } }),
    });
  }

  it('enterPlanMode：权限切 plan、记录 previousMode、发 plan-mode-changed 事件', () => {
    const session = bareSession('default');
    session.setPermissionMode('acceptEdits');
    const events = planModeEvents(session);

    expect(session.isPlanMode()).toBe(false);
    expect(session.enterPlanMode()).toBe(true);

    expect(session.isPlanMode()).toBe(true);
    expect(session.getPermissionMode()).toBe('plan');
    expect(events).toEqual([
      { type: 'plan-mode-changed', active: true, mode: 'plan', previousMode: 'acceptEdits' },
    ]);
  });

  it('重复 enterPlanMode 幂等：返回 false，不发事件', () => {
    const session = bareSession();
    session.enterPlanMode();
    const events = planModeEvents(session);
    expect(session.enterPlanMode()).toBe(false);
    expect(events).toEqual([]);
    expect(session.getPermissionMode()).toBe('plan');
  });

  it('exitPlanMode 恢复进入前的权限模式并发事件；未激活时返回 false', () => {
    const session = bareSession('default');
    expect(session.exitPlanMode()).toBe(false);

    session.enterPlanMode();
    const events = planModeEvents(session);
    expect(session.exitPlanMode()).toBe(true);

    expect(session.isPlanMode()).toBe(false);
    expect(session.getPermissionMode()).toBe('default');
    expect(events).toEqual([
      { type: 'plan-mode-changed', active: false, mode: 'default', previousMode: 'default' },
    ]);
  });

  it('启动即 plan 模式（--mode plan）：planMode 激活，退出来路为 default', () => {
    const session = bareSession('plan');
    expect(session.isPlanMode()).toBe(true);
    expect(session.getPermissionMode()).toBe('plan');
    expect(session.exitPlanMode()).toBe(true);
    expect(session.getPermissionMode()).toBe('default');
  });

  it('setPermissionMode(plan) 进入完整计划模式；计划中切走以用户选择为目标（不恢复来路）', () => {
    const session = bareSession('default');
    session.setPermissionMode('acceptEdits');
    session.setPermissionMode('plan');
    expect(session.isPlanMode()).toBe(true);
    expect(session.getPermissionMode()).toBe('plan');

    // 用户在计划模式中显式切到 bypassPermissions：退出计划模式，目标是用户选择而非 acceptEdits
    session.setPermissionMode('bypassPermissions');
    expect(session.isPlanMode()).toBe(false);
    expect(session.getPermissionMode()).toBe('bypassPermissions');
  });

  it('非计划模式下的普通切换不发 plan-mode-changed', () => {
    const session = bareSession('default');
    const events = planModeEvents(session);
    session.setPermissionMode('acceptEdits');
    expect(events).toEqual([]);
    expect(session.getPermissionMode()).toBe('acceptEdits');
  });
});

describe('plan 工具单测', () => {
  it('enter_plan_mode describeCall：有 reason 带上，无则回退', () => {
    const tool = createEnterPlanModeTool();
    expect(tool.describeCall({ reason: '任务复杂' })).toBe('进入计划模式：任务复杂');
    expect(tool.describeCall({})).toBe('进入计划模式');
    // reason 全部可选：未知字段被 schema 剥掉，解析仍成功
    expect(tool.describeCall({ nope: 1 })).toBe('进入计划模式');
  });

  it('exit_plan_mode describeCall：计划首行前 50 字截断', () => {
    const tool = createExitPlanModeTool();
    expect(tool.describeCall({ plan: '# 标题\n正文' })).toBe('提交计划：# 标题');
    const long = { plan: `${'计'.repeat(60)}\n正文` };
    expect(tool.describeCall(long)).toBe(`提交计划：${'计'.repeat(50)}…`);
  });

  it('无宿主能力：两工具回喂不支持，isError', async () => {
    const enter = await createEnterPlanModeTool().call({}, ctx);
    expect(enter.isError).toBe(true);
    expect(enter.output).toContain('不支持计划模式');
    const exit = await createExitPlanModeTool().call({ plan: '# x' }, ctx);
    expect(exit.isError).toBe(true);
    expect(exit.output).toContain('不支持计划模式');
  });

  it('enter/exit 幂等与前置校验（内存宿主）', async () => {
    let active = false;
    const host: PlanModeHost = {
      isPlanMode: () => active,
      enterPlanMode: () => {
        if (active) {
          return false;
        }
        active = true;
        return true;
      },
      exitPlanMode: () => {
        if (!active) {
          return false;
        }
        active = false;
        return true;
      },
      requestPlanApproval: () => Promise.resolve({ approved: true }),
    };
    const enter = createEnterPlanModeTool(host);
    const exit = createExitPlanModeTool(host);

    const first = await enter.call({}, ctx);
    expect(first.output).toContain('已进入计划模式');
    const again = await enter.call({}, ctx);
    expect(again.output).toContain('已在计划模式中');
    expect(again.isError).toBeUndefined();

    const approved = await exit.call({ plan: '# 计划' }, ctx);
    expect(approved.output).toContain('计划已获批准');
    expect(approved.isError).toBeUndefined();
    expect(active).toBe(false);

    const notInPlan = await exit.call({ plan: '# 计划' }, ctx);
    expect(notInPlan.isError).toBe(true);
    expect(notInPlan.output).toContain('不在计划模式');
  });
});

describe('plan 工具权限判定', () => {
  const enter = createEnterPlanModeTool();
  const exit = createExitPlanModeTool();
  const makeCtx = (overrides?: Partial<PermissionContext>): PermissionContext => ({
    mode: 'default',
    rules: [],
    sessionApprovals: [],
    cwd,
    ...overrides,
  });

  it('交互型工具：default / plan / bypass 模式都直接放行，不弹审批', () => {
    for (const mode of ['default', 'plan', 'bypassPermissions'] as const) {
      expect(evaluatePermission(enter, {}, makeCtx({ mode }))).toEqual({ kind: 'allow' });
      expect(evaluatePermission(exit, { plan: 'x' }, makeCtx({ mode }))).toEqual({ kind: 'allow' });
    }
  });

  it('deny 规则仍然优先于交互型放行', () => {
    const rules: PermissionRule[] = [{ action: 'deny', tool: 'exit_plan_mode' }];
    expect(evaluatePermission(exit, { plan: 'x' }, makeCtx({ rules })).kind).toBe('deny');
  });

  it('调度按 execute 独占（挂起等批准期间串行）', () => {
    expect(enter.accesses({})).toEqual([{ kind: 'execute' }]);
    expect(exit.accesses({ plan: 'x' })).toEqual([{ kind: 'execute' }]);
    expect(enter.isReadOnly({})).toBe(false);
    expect(exit.isReadOnly({ plan: 'x' })).toBe(false);
  });
});

describe('plan 模式闭环：loop 与 session', () => {
  /** 与 main.ts 相同的接线：plan 工具经 sessionRef 闭包拿到 Session 的计划模式能力 */
  function makePlanSession(
    provider: FakeProvider,
    options: { permission?: SessionConfig['permission']; sessionCwd?: string } = {},
  ): Session {
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
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: options.sessionCwd ?? cwd,
      ...(options.permission === undefined ? {} : { permission: options.permission }),
    });
    sessionRef = session;
    return session;
  }

  it('完整闭环：enter → prompt 注入 → write 被拒 → exit 批准 → 恢复来路 → write 放行', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'misty-plan-'));
    const plan = '# 计划\n1. 写 a.txt';
    const provider = new FakeProvider([
      toolCallStep([{ name: 'enter_plan_mode', arguments: '{"reason":"先规划"}' }]),
      toolCallStep([{ name: 'write', arguments: '{"path":"a.txt","content":"hi"}' }]),
      toolCallStep([{ name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) }]),
      toolCallStep([{ name: 'write', arguments: '{"path":"a.txt","content":"hi"}' }]),
      textStep('完成'),
    ]);
    const session = makePlanSession(provider, { sessionCwd: dir });
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
      if (event.type === 'plan-approval-requested') {
        session.submit({
          type: 'plan-approval-reply',
          id: event.request.id,
          reply: { approved: true },
        });
      }
      if (event.type === 'approval-requested') {
        session.submit({ type: 'approval-reply', id: event.request.id, reply: { decision: 'once' } });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    // prompt 注入是步级的：进入前没有指引，进入后下一步即有，批准退出后恢复
    expect(provider.requests[0]!.systemPrompt).toBe('system');
    expect(provider.requests[1]!.systemPrompt).toContain('当前处于计划模式');
    expect(provider.requests[3]!.systemPrompt).toBe('system');

    const toolMessages = session.getMessages().filter((m): m is ToolMessage => m.role === 'tool');
    expect(toolMessages[0]!.content).toContain('已进入计划模式');
    // 计划模式中 write 被权限直接拒绝（不弹审批）
    expect(toolMessages[1]!.isError).toBe(true);
    expect(toolMessages[1]!.content).toContain('plan 模式为只读');
    expect(toolMessages[2]!.content).toContain('计划已获批准');
    // 退出后恢复 default：write 走正常审批（once 放行）并真正落盘
    expect(toolMessages[3]!.isError).toBeUndefined();
    await expect(readFile(path.join(dir, 'a.txt'), 'utf8')).resolves.toBe('hi');

    // 计划全文随 assistant toolCalls 保留在历史里
    const exitCall = session
      .getMessages()
      .filter((m): m is AssistantMessage => m.role === 'assistant')
      .flatMap((m) => m.toolCalls ?? [])
      .find((call) => call.name === 'exit_plan_mode');
    expect(exitCall?.arguments).toContain('# 计划');

    expect(session.isPlanMode()).toBe(false);
    expect(session.getPermissionMode()).toBe('default');
    const modeChanges = events.filter(
      (e): e is PlanModeChangedEvent => e.type === 'plan-mode-changed',
    );
    expect(modeChanges).toEqual([
      { type: 'plan-mode-changed', active: true, mode: 'plan', previousMode: 'default' },
      { type: 'plan-mode-changed', active: false, mode: 'default', previousMode: 'default' },
    ]);
    expect(planApprovals(events)).toHaveLength(1);
    expect(planApprovals(events)[0]!.request.plan).toBe(plan);
  });

  it('exit 拒绝：isError + feedback 回喂，仍在计划模式；修订后再次提交获批', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'exit_plan_mode', arguments: JSON.stringify({ plan: 'v1' }) }]),
      toolCallStep([{ name: 'exit_plan_mode', arguments: JSON.stringify({ plan: 'v2' }) }]),
      textStep('开始执行'),
    ]);
    const session = makePlanSession(provider, { permission: { mode: 'plan' } });
    let submissions = 0;
    session.onEvent((event) => {
      if (event.type === 'plan-approval-requested') {
        submissions += 1;
        session.submit({
          type: 'plan-approval-reply',
          id: event.request.id,
          reply:
            submissions === 1
              ? { approved: false, feedback: '补充验收标准' }
              : { approved: true },
        });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(submissions).toBe(2);
    const toolMessages = session.getMessages().filter((m): m is ToolMessage => m.role === 'tool');
    expect(toolMessages[0]!.isError).toBe(true);
    expect(toolMessages[0]!.content).toContain('计划被拒绝');
    expect(toolMessages[0]!.content).toContain('补充验收标准');
    expect(toolMessages[1]!.content).toContain('计划已获批准');
    expect(session.isPlanMode()).toBe(false);
    // --mode plan 启动的来路是 default
    expect(session.getPermissionMode()).toBe('default');
  });

  it('计划批准挂起期间 interrupt：落定拒绝，turn 以 interrupted 收尾，仍在计划模式', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'exit_plan_mode', arguments: JSON.stringify({ plan: 'v1' }) }]),
    ]);
    const session = makePlanSession(provider, { permission: { mode: 'plan' } });
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
      if (event.type === 'plan-approval-requested') {
        session.interrupt();
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('interrupted');
    expect(planApprovals(events)).toHaveLength(1);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toBe('interrupted by user');
    // 中断不退出计划模式（由用户显式切换）
    expect(session.isPlanMode()).toBe(true);
  });

  it('非计划模式调用 exit_plan_mode：isError 提示，不发审批事件', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'exit_plan_mode', arguments: JSON.stringify({ plan: 'v1' }) }]),
      textStep('直接执行'),
    ]);
    const session = makePlanSession(provider);
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(planApprovals(events)).toHaveLength(0);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('不在计划模式');
  });

  it('计划模式中模型重复 enter_plan_mode：幂等提示，不发第二次 mode 事件', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'enter_plan_mode', arguments: '{}' }]),
      textStep('继续调研'),
    ]);
    const session = makePlanSession(provider, { permission: { mode: 'plan' } });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBeUndefined();
    expect(toolMessage.content).toContain('已在计划模式中');
    expect(events.some((e) => e.type === 'plan-mode-changed')).toBe(false);
    expect(session.isPlanMode()).toBe(true);
  });

  it('--mode plan 启动：首个请求的 system prompt 即带计划指引', async () => {
    const provider = new FakeProvider([textStep('先调研')]);
    const session = makePlanSession(provider, { permission: { mode: 'plan' } });

    await session.submit({ type: 'user-turn', text: 'go' });

    expect(provider.requests[0]!.systemPrompt).toBe(`system\n\n${buildPlanModePrompt()}`);
  });
});

describe('plan 工具在无宿主的 registry（缺省接线）', () => {
  it('未注入 planMode 宿主：enter 回喂不支持，不产生 mode 变化', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'enter_plan_mode', arguments: '{}' }]),
      textStep('明白了'),
    ]);
    const registry = createBuiltinRegistry();
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd,
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(session.isPlanMode()).toBe(false);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('不支持计划模式');
  });
});
