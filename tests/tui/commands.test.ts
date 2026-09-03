import { describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '#/config/schema';
import { Session } from '#/core/session/session';
import {
  isSlashCommand,
  runSlashCommand,
  slashCommands,
  type CommandContext,
} from '#/tui/commands';

import { FakeProvider, textStep } from '../core/fake-provider';

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  session: Session;
  notices: string[];
} {
  const provider = new FakeProvider([textStep('摘要'), textStep('回复')]);
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: [],
    cwd: process.cwd(),
    permission: { mode: 'bypassPermissions' },
  });
  const notices: string[] = [];
  const ctx: CommandContext = {
    session,
    busy: false,
    notice: (text) => notices.push(text),
    clearBlocks: vi.fn(),
    setModel: (model) => session.setModel(model),
    setMode: (mode: PermissionMode) => session.setPermissionMode(mode),
    exit: vi.fn(),
    ...overrides,
  };
  return { ctx, session, notices };
}

describe('isSlashCommand', () => {
  it('以 / 开头的输入是命令', () => {
    expect(isSlashCommand('/help')).toBe(true);
    expect(isSlashCommand('  /model x')).toBe(true);
    expect(isSlashCommand('hello')).toBe(false);
    expect(isSlashCommand('a/b')).toBe(false);
  });
});

describe('runSlashCommand', () => {
  it('未知命令给出提示', async () => {
    const { ctx, notices } = makeCtx();
    await runSlashCommand('/nope', ctx);
    expect(notices[0]).toContain('未知命令：/nope');
  });

  it('/help 列出全部命令', async () => {
    const { ctx, notices } = makeCtx();
    await runSlashCommand('/help', ctx);
    for (const command of slashCommands) {
      expect(notices[0]).toContain(command.usage);
    }
  });

  it('/model 切换模型', async () => {
    const { ctx, session, notices } = makeCtx();
    await runSlashCommand('/model gpt-x', ctx);
    expect(session.getModel()).toBe('gpt-x');
    expect(notices[0]).toContain('已切换模型：gpt-x');
  });

  it('/model 无参数显示当前模型', async () => {
    const { ctx, notices } = makeCtx();
    await runSlashCommand('/model', ctx);
    expect(notices[0]).toContain('当前模型：fake-model');
  });

  it('/mode 切换权限模式', async () => {
    const { ctx, session, notices } = makeCtx();
    await runSlashCommand('/mode plan', ctx);
    expect(session.getPermissionMode()).toBe('plan');
    expect(notices[0]).toContain('已切换权限模式：plan');
  });

  it('/mode 无参数显示当前模式；无效模式不切换', async () => {
    const { ctx, session, notices } = makeCtx();
    await runSlashCommand('/mode', ctx);
    expect(notices[0]).toContain('当前权限模式：bypassPermissions');

    await runSlashCommand('/mode yolo', ctx);
    expect(notices[1]).toContain('无效模式：yolo');
    expect(session.getPermissionMode()).toBe('bypassPermissions');
  });

  it('/clear 清历史并清屏', async () => {
    const { ctx, session, notices } = makeCtx();
    await session.submit({ type: 'user-turn', text: '先跑一轮' });
    expect(session.getMessages().length).toBeGreaterThan(0);

    await runSlashCommand('/clear', ctx);

    expect(session.getMessages()).toHaveLength(0);
    expect(ctx.clearBlocks).toHaveBeenCalledOnce();
    expect(notices.at(-1)).toContain('已开始新会话');
  });

  it('/clear 在 turn 进行中拒绝', async () => {
    const { ctx } = makeCtx({ busy: true });
    await runSlashCommand('/clear', ctx);
    expect(ctx.clearBlocks).not.toHaveBeenCalled();
  });

  it('/compact 历史太短时不压缩', async () => {
    const { ctx, notices } = makeCtx();
    await runSlashCommand('/compact', ctx);
    expect(notices[0]).toContain('未压缩');
  });

  it('/compact 压缩历史并触发 compacted 事件', async () => {
    const session = new Session({
      provider: new FakeProvider([textStep('摘要内容')]),
      model: 'fake-model',
      systemPrompt: 'system',
      tools: [],
      cwd: process.cwd(),
      initialMessages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'a3' },
      ],
    });
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    const { ctx } = makeCtx({ session });

    await runSlashCommand('/compact', ctx);

    expect(session.getMessages()).toHaveLength(5);
    expect(session.getMessages()[0]!.content).toContain('摘要内容');
    expect(events).toEqual(['compacted']);
  });

  it('/exit 调用退出', async () => {
    const { ctx } = makeCtx();
    await runSlashCommand('/exit', ctx);
    expect(ctx.exit).toHaveBeenCalledOnce();
  });
});
