import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '#/core/events';
import { Session, type SessionConfig } from '#/core/session/session';
import { loadTranscript, resumeSession } from '#/core/session/transcript';

import { FakeProvider, textStep } from './fake-provider';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'misty-session-persist-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSession(
  provider: FakeProvider,
  overrides: Partial<SessionConfig> = {},
): Session {
  return new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: [],
    cwd: process.cwd(),
    permission: { mode: 'bypassPermissions' },
    transcript: { dir },
    ...overrides,
  });
}

describe('Session 持久化', () => {
  it('user 消息先落盘再进 loop，assistant 消息产生时落盘', async () => {
    const provider = new FakeProvider([textStep('hi')]);
    const session = makeSession(provider);

    await session.submit({ type: 'user-turn', text: 'hello' });

    const sessionId = session.getSessionId()!;
    const entries = loadTranscript(join(dir, `${sessionId}.jsonl`));
    expect(entries.map((entry) => entry.type)).toEqual(['meta', 'user', 'assistant']);
    expect(entries[0]!.message).toMatchObject({ sessionId, model: 'fake-model' });
    // uuid 链：meta → user → assistant
    expect(entries[1]!.parentUuid).toBe(entries[0]!.uuid);
    expect(entries[2]!.parentUuid).toBe(entries[1]!.uuid);
  });

  it('resume：重建历史后续写同一文件，uuid 链接上', async () => {
    const provider = new FakeProvider([textStep('first')]);
    const session = makeSession(provider);
    await session.submit({ type: 'user-turn', text: 'q1' });
    const sessionId = session.getSessionId()!;
    const filePath = join(dir, `${sessionId}.jsonl`);

    const resumed = resumeSession(filePath);
    expect(resumed.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

    const second = makeSession(new FakeProvider([textStep('second')]), {
      transcript: { dir, sessionId },
      initialMessages: resumed.messages,
    });
    expect(second.getMessages().map((message) => message.role)).toEqual(['user', 'assistant']);

    await second.submit({ type: 'user-turn', text: 'q2' });

    const entries = loadTranscript(filePath);
    // 原 meta/user/assistant + resume 新 meta + 新 user/assistant
    expect(entries.map((entry) => entry.type)).toEqual([
      'meta',
      'user',
      'assistant',
      'meta',
      'user',
      'assistant',
    ]);
    // 链式追加：resume 后的 meta 接在旧尾部之后
    expect(entries[3]!.parentUuid).toBe(entries[2]!.uuid);
    expect(entries[4]!.parentUuid).toBe(entries[3]!.uuid);
  });

  it('自动压缩：超过阈值时摘要重建历史并 dispatch compacted 事件', async () => {
    const provider = new FakeProvider([textStep('摘要内容'), textStep('回答')]);
    const session = makeSession(provider, {
      maxContextTokens: 10,
      initialMessages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'a3' },
      ],
    });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    await session.submit({ type: 'user-turn', text: 'hello' });

    // 第一次 provider 调用是摘要请求，第二次是真实 step
    expect(provider.requests).toHaveLength(2);
    const compacted = events.find((event) => event.type === 'compacted');
    expect(compacted).toBeDefined();
    expect(session.getMessages()[0]).toEqual({
      role: 'user',
      content: '[历史对话摘要]\n摘要内容',
    });
    // 摘要消息也落盘，且先于它写入 compact-checkpoint
    const sessionId = session.getSessionId()!;
    const entries = loadTranscript(join(dir, `${sessionId}.jsonl`));
    expect(entries.map((entry) => entry.type)).toEqual(['meta', 'user', 'meta', 'user', 'assistant']);
    expect(entries[2]!.message).toMatchObject({ kind: 'compact-checkpoint' });
    expect((entries[3]!.message as { content: string }).content).toContain('摘要内容');
  });

  it('未达压缩阈值时不触发摘要调用', async () => {
    const provider = new FakeProvider([textStep('hi')]);
    const session = makeSession(provider);

    await session.submit({ type: 'user-turn', text: 'hello' });

    expect(provider.requests).toHaveLength(1);
  });

  it('setModel 对后续请求立即生效', async () => {
    const provider = new FakeProvider([textStep('a'), textStep('b')]);
    const session = makeSession(provider);

    await session.submit({ type: 'user-turn', text: 'one' });
    session.setModel('new-model');
    await session.submit({ type: 'user-turn', text: 'two' });

    expect(provider.requests[0]!.model).toBe('fake-model');
    expect(provider.requests[1]!.model).toBe('new-model');
  });

  it('newSession 清历史并开新 transcript 文件', async () => {
    const provider = new FakeProvider([textStep('a'), textStep('b')]);
    const session = makeSession(provider);
    await session.submit({ type: 'user-turn', text: 'q1' });
    const firstId = session.getSessionId()!;

    session.newSession();

    expect(session.getMessages()).toHaveLength(0);
    expect(session.getSessionId()).not.toBe(firstId);
    await session.submit({ type: 'user-turn', text: 'q2' });
    const secondId = session.getSessionId()!;
    expect(loadTranscript(join(dir, `${secondId}.jsonl`)).map((entry) => entry.type)).toEqual([
      'meta',
      'user',
      'assistant',
    ]);
    // 旧文件不受新会话影响
    expect(loadTranscript(join(dir, `${firstId}.jsonl`))).toHaveLength(3);
  });

  it('压缩后 resume：从 checkpoint 恢复，历史以摘要开头而非重放原始历史', async () => {
    const provider = new FakeProvider([textStep('摘要内容'), textStep('回答')]);
    const session = makeSession(provider, {
      maxContextTokens: 10,
      initialMessages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'a3' },
      ],
    });

    await session.submit({ type: 'user-turn', text: 'hello' });

    const filePath = join(dir, `${session.getSessionId()!}.jsonl`);
    const resumed = resumeSession(filePath);
    expect(resumed.messages[0]).toEqual({ role: 'user', content: '[历史对话摘要]\n摘要内容' });
    // checkpoint 之前的 user('hello') 被丢弃，之后只有摘要与新 assistant
    expect(resumed.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('多次压缩：resume 以最后一个 checkpoint 为准', async () => {
    const provider = new FakeProvider([textStep('摘要一'), textStep('回答一'), textStep('摘要二')]);
    const session = makeSession(provider, {
      maxContextTokens: 10,
      initialMessages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'a3' },
      ],
    });

    await session.submit({ type: 'user-turn', text: 'hello' });
    // 第一次压缩后历史为 摘要+保留尾部+回答一（>keepRecent），可再次手动压缩
    expect(await session.compactNow()).toBe(true);
    expect(session.getMessages()[0]).toEqual({ role: 'user', content: '[历史对话摘要]\n摘要二' });

    const filePath = join(dir, `${session.getSessionId()!}.jsonl`);
    const checkpoints = loadTranscript(filePath).filter(
      (entry) =>
        entry.type === 'meta' &&
        (entry.message as { kind?: unknown }).kind === 'compact-checkpoint',
    );
    expect(checkpoints).toHaveLength(2);

    const resumed = resumeSession(filePath);
    expect(resumed.messages[0]).toEqual({ role: 'user', content: '[历史对话摘要]\n摘要二' });
  });
});
