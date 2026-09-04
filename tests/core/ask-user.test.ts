import { describe, expect, it } from 'vitest';

import type { PermissionRule } from '#/config/schema';
import type { AgentEvent, QuestionAskedEvent } from '#/core/events';
import { evaluatePermission, type PermissionContext } from '#/core/permission/pipeline';
import type { AskUserFn } from '#/core/question';
import { Session, type SessionConfig } from '#/core/session/session';
import { createAskUserTool } from '#/core/tools/builtin/ask-user';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import type { ToolContext } from '#/core/tools/tool';
import type { ToolMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

const ctx: ToolContext = { cwd, signal: new AbortController().signal };

const validInput = {
  question: '选哪个方案？',
  options: [{ label: '甲', description: '保守' }, { label: '乙' }],
};

const replyWith: (answers: string[]) => AskUserFn = (answers) => () => Promise.resolve({ answers });
const replyCancelled: AskUserFn = () => Promise.resolve({ cancelled: true });

describe('ask_user 工具', () => {
  it('describeCall：Ask: 前缀 + 问题前 50 字截断', () => {
    const tool = createAskUserTool();
    expect(tool.describeCall(validInput)).toBe('Ask: 选哪个方案？');
    const long = { ...validInput, question: '问'.repeat(60) };
    expect(tool.describeCall(long)).toBe(`Ask: ${'问'.repeat(50)}…`);
    expect(tool.describeCall({ nope: 1 })).toBe('ask_user');
  });

  it('input schema：options 少于 2 或多于 4 个不合法', () => {
    const tool = createAskUserTool();
    expect(tool.inputSchema.safeParse(validInput).success).toBe(true);
    expect(tool.inputSchema.safeParse({ ...validInput, options: [{ label: '甲' }] }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        ...validInput,
        options: [1, 2, 3, 4, 5].map((n) => ({ label: `选项${n}` })),
      }).success,
    ).toBe(false);
  });

  it('无 askUser 宿主能力（无头模式）：直接回喂自行决策，不挂起', async () => {
    const tool = createAskUserTool();
    const result = await tool.call(validInput, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('无头');
    expect(result.output).toContain('自行决策');
  });

  it('answers 回喂：输出用户选择', async () => {
    const tool = createAskUserTool(replyWith(['甲']));
    const result = await tool.call(validInput, ctx);
    expect(result.output).toBe('用户选择了：甲');
    expect(result.isError).toBeUndefined();
  });

  it('cancelled 回喂：isError + 用户取消了提问', async () => {
    const tool = createAskUserTool(replyCancelled);
    const result = await tool.call(validInput, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('用户取消了提问');
  });

  it('空 answers 回喂：按未作答处理', async () => {
    const tool = createAskUserTool(replyWith([]));
    const result = await tool.call(validInput, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('没有选择任何选项');
  });
});

describe('ask_user 权限判定', () => {
  const tool = createAskUserTool();
  const makeCtx = (overrides?: Partial<PermissionContext>): PermissionContext => ({
    mode: 'default',
    rules: [],
    sessionApprovals: [],
    cwd,
    ...overrides,
  });

  it('交互型工具：default / plan / bypass 模式都直接放行，不弹审批', () => {
    for (const mode of ['default', 'plan', 'bypassPermissions'] as const) {
      expect(evaluatePermission(tool, validInput, makeCtx({ mode }))).toEqual({ kind: 'allow' });
    }
  });

  it('deny 规则仍然优先于交互型放行', () => {
    const rules: PermissionRule[] = [{ action: 'deny', tool: 'ask_user' }];
    const decision = evaluatePermission(tool, validInput, makeCtx({ rules }));
    expect(decision.kind).toBe('deny');
  });

  it('调度按 execute 独占：与任何访问冲突（串行等回答）', () => {
    expect(tool.accesses(validInput)).toEqual([{ kind: 'execute' }]);
    expect(tool.isReadOnly(validInput)).toBe(false);
  });
});

describe('ask_user 接线：loop 与 session', () => {
  function makeSession(
    provider: FakeProvider,
    interactive: boolean,
    permission?: SessionConfig['permission'],
  ): Session {
    let sessionRef: Session | null = null;
    const registry = createBuiltinRegistry({
      askUser: interactive
        ? (request, signal) =>
            sessionRef?.askUser(request, signal) ?? Promise.resolve({ cancelled: true })
        : undefined,
    });
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd,
      ...(permission === undefined ? {} : { permission }),
    });
    sessionRef = session;
    return session;
  }

  const askCall = {
    name: 'ask_user',
    arguments: JSON.stringify(validInput),
  };

  it('提问挂起 → question-reply 回复 → 结果回喂模型继续 turn', async () => {
    const provider = new FakeProvider([
      toolCallStep([askCall]),
      textStep('按你的选择继续'),
    ]);
    const session = makeSession(provider, true);
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
      if (event.type === 'question-asked') {
        // 监听器同步回复：提问必须先挂起再发事件
        session.submit({ type: 'question-reply', id: event.request.id, reply: { answers: ['乙'] } });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    const asked = events.filter((e): e is QuestionAskedEvent => e.type === 'question-asked');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.request).toMatchObject({ question: '选哪个方案？' });
    // 交互型工具不弹审批
    expect(events.some((e) => e.type === 'approval-requested')).toBe(false);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.content).toBe('用户选择了：乙');
    expect(toolMessage.isError).toBeUndefined();
    // 回答进入了下一步请求的历史
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('用户取消（cancelled）：isError 结果回喂，turn 继续', async () => {
    const provider = new FakeProvider([toolCallStep([askCall]), textStep('那我自行决定')]);
    const session = makeSession(provider, true);
    session.onEvent((event) => {
      if (event.type === 'question-asked') {
        session.submit({ type: 'question-reply', id: event.request.id, reply: { cancelled: true } });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('用户取消了提问');
  });

  it('提问挂起期间 interrupt：挂起落定 cancelled，turn 以 interrupted 收尾', async () => {
    const provider = new FakeProvider([toolCallStep([askCall])]);
    const session = makeSession(provider, true);
    session.onEvent((event) => {
      if (event.type === 'question-asked') {
        session.interrupt();
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('interrupted');
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.content).toBe('interrupted by user');
    expect(toolMessage.isError).toBe(true);
  });

  it('无 askUser 宿主能力（print 无头模式接线）：回喂自行决策，不发 question-asked', async () => {
    const provider = new FakeProvider([toolCallStep([askCall]), textStep('自行决策收尾')]);
    const session = makeSession(provider, false);
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(events.some((e) => e.type === 'question-asked')).toBe(false);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('自行决策');
  });

  it('同一批多个 ask_user 串行独占：第二问等第一问回答后才开始', async () => {
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'ask_user',
          arguments: JSON.stringify({ ...validInput, question: '第一问？' }),
        },
        {
          name: 'ask_user',
          arguments: JSON.stringify({ ...validInput, question: '第二问？' }),
        },
      ]),
      textStep('两问都答完'),
    ]);
    const session = makeSession(provider, true);
    const log: string[] = [];
    session.onEvent((event) => {
      if (event.type === 'question-asked') {
        log.push(`asked:${event.request.question}`);
        // 延迟回复：若两问并发，日志会是 asked/asked/replied/replied
        setTimeout(() => {
          log.push(`replied:${event.request.question}`);
          session.submit({ type: 'question-reply', id: event.request.id, reply: { answers: ['好'] } });
        }, 20);
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(log).toEqual([
      'asked:第一问？',
      'replied:第一问？',
      'asked:第二问？',
      'replied:第二问？',
    ]);
    const toolMessages = session
      .getMessages()
      .filter((m): m is ToolMessage => m.role === 'tool');
    expect(toolMessages.map((m) => m.content)).toEqual(['用户选择了：好', '用户选择了：好']);
  });
});
