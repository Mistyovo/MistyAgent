import { describe, expect, it, vi } from 'vitest';

import { Session } from '#/core/session/session';
import { runSlashCommand, type CommandContext } from '#/tui/commands';

import { FakeProvider, textStep } from '../core/fake-provider';

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  notices: string[];
} {
  const session = new Session({
    provider: new FakeProvider([textStep('回复')]),
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
    setMode: (mode) => session.setPermissionMode(mode),
    exit: vi.fn(),
    ...overrides,
  };
  return { ctx, notices };
}

describe('/memory', () => {
  it('记忆未开启时提示开启方式', async () => {
    const { ctx, notices } = makeCtx();
    await runSlashCommand('/memory', ctx);
    expect(notices[0]).toContain('记忆未开启');
    expect(notices[0]).toContain('memory: true');
  });

  it('开启时显示记忆目录与当前索引', async () => {
    const { ctx, notices } = makeCtx({
      memoryInfo: () => '记忆目录：/home/u/.misty/memory\n\n- [用户偏好](user_prefs.md) — 喜欢简洁回答',
    });
    await runSlashCommand('/memory', ctx);
    expect(notices[0]).toContain('记忆目录：/home/u/.misty/memory');
    expect(notices[0]).toContain('[用户偏好](user_prefs.md)');
  });

  it('开启但索引为空时显示空说明', async () => {
    const { ctx, notices } = makeCtx({
      memoryInfo: () => '记忆目录：/home/u/.misty/memory\n（索引为空：还没有写入任何记忆）',
    });
    await runSlashCommand('/memory', ctx);
    expect(notices[0]).toContain('索引为空');
  });
});

describe('/skills', () => {
  it('skillsInfo 缺省时提示未加载', async () => {
    const { ctx, notices } = makeCtx();
    await runSlashCommand('/skills', ctx);
    expect(notices[0]).toContain('未加载任何 skill');
    expect(notices[0]).toContain('~/.misty/skills/<name>/SKILL.md');
  });

  it('skillsInfo 返回空串时提示未加载', async () => {
    const { ctx, notices } = makeCtx({ skillsInfo: () => '' });
    await runSlashCommand('/skills', ctx);
    expect(notices[0]).toContain('未加载任何 skill');
  });

  it('显示非空技能清单（含来源标注）', async () => {
    const { ctx, notices } = makeCtx({
      skillsInfo: () =>
        ['已加载技能：', '  skillify — 把本会话流程固化为 skill（内置）', '  review — 代码评审（项目级）'].join('\n'),
    });
    await runSlashCommand('/skills', ctx);
    expect(notices[0]).toContain('skillify');
    expect(notices[0]).toContain('review — 代码评审（项目级）');
  });
});
