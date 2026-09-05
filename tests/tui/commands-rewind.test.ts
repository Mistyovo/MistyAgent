import { describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '#/config/schema';
import { Session } from '#/core/session/session';
import { runSlashCommand, type CommandContext } from '#/tui/commands';

import { FakeProvider, textStep } from '../core/fake-provider';

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  notices: string[];
} {
  const provider = new FakeProvider([textStep('回复')]);
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
  return { ctx, notices };
}

describe('/rewind', () => {
  it('rewind 回调缺省时提示不可用', async () => {
    const { ctx, notices } = makeCtx();
    await runSlashCommand('/rewind', ctx);
    expect(notices[0]).toContain('检查点不可用');
  });

  it('无参数列出检查点清单并附用法', async () => {
    const rewind = vi.fn((id?: string): string =>
      id === undefined ? '可回滚的检查点：\n  1  12:00:00  改文件（改动 1 个文件）' : '已回滚',
    );
    const { ctx, notices } = makeCtx({ rewind });

    await runSlashCommand('/rewind', ctx);

    expect(rewind).toHaveBeenCalledWith();
    expect(notices[0]).toContain('可回滚的检查点');
    expect(notices[0]).toContain('/rewind <id> 回滚到该检查点');
  });

  it('带 id 透传回滚', async () => {
    const rewind = vi.fn(
      (id?: string): string => `已回滚到检查点 ${id}：还原 1 个文件，删除 0 个新建文件`,
    );
    const { ctx, notices } = makeCtx({ rewind });

    await runSlashCommand('/rewind 2', ctx);

    expect(rewind).toHaveBeenCalledWith('2');
    expect(notices[0]).toContain('已回滚到检查点 2');
  });
});
