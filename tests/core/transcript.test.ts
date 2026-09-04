import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listSessions,
  loadTranscript,
  resumeSession,
  sanitizeCwd,
  transcriptDirFor,
  TranscriptWriter,
} from '#/core/session/transcript';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'misty-transcript-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sanitizeCwd / transcriptDirFor', () => {
  it('盘符冒号与路径分隔符替换为 -', () => {
    expect(sanitizeCwd('C:\\Users\\foo\\bar')).toBe('C--Users-foo-bar');
    expect(sanitizeCwd('C:/Users/foo')).toBe('C--Users-foo');
    expect(sanitizeCwd('/home/foo')).toBe('-home-foo');
  });

  it('transcript 目录落在 <home>/.misty/projects 下', () => {
    expect(transcriptDirFor('C:\\proj', root)).toBe(join(root, '.misty', 'projects', 'C--proj'));
  });
});

describe('TranscriptWriter / loadTranscript', () => {
  it('写入读取往返，uuid/parentUuid 链式追加', () => {
    const filePath = join(root, 's1.jsonl');
    const writer = new TranscriptWriter(filePath);
    const meta = writer.append('meta', { sessionId: 's1' });
    const user = writer.appendMessage({ role: 'user', content: 'hi' });
    const assistant = writer.appendMessage({ role: 'assistant', content: 'hello' });

    expect(meta.parentUuid).toBeNull();
    expect(user.parentUuid).toBe(meta.uuid);
    expect(assistant.parentUuid).toBe(user.uuid);

    const entries = loadTranscript(filePath);
    expect(entries.map((entry) => entry.type)).toEqual(['meta', 'user', 'assistant']);
    expect(entries[1]!.message).toEqual({ role: 'user', content: 'hi' });
    expect(entries[2]!.uuid).toBe(assistant.uuid);
  });

  it('已有文件续写时从尾部恢复 uuid 链', () => {
    const filePath = join(root, 's2.jsonl');
    const first = new TranscriptWriter(filePath);
    const tail = first.appendMessage({ role: 'user', content: 'a' });

    const second = new TranscriptWriter(filePath);
    const next = second.appendMessage({ role: 'assistant', content: 'b' });

    expect(next.parentUuid).toBe(tail.uuid);
    expect(loadTranscript(filePath)).toHaveLength(2);
  });

  it('损坏行跳过，不影响其余行解析', () => {
    const filePath = join(root, 'bad.jsonl');
    writeFileSync(
      filePath,
      `${JSON.stringify({ uuid: 'u1', parentUuid: null, type: 'user', timestamp: 't', message: { role: 'user', content: 'ok' } })}\nnot-json\n\n`,
    );
    const entries = loadTranscript(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.uuid).toBe('u1');
  });

  it('loadTranscript 文件不存在返回空', () => {
    expect(loadTranscript(join(root, 'missing.jsonl'))).toEqual([]);
  });
});

describe('listSessions', () => {
  it('按 mtime 倒序，含首条用户消息摘要', () => {
    const dir = transcriptDirFor('C:\\proj', root);
    mkdirSync(dir, { recursive: true });
    const older = new TranscriptWriter(join(dir, 'aaa.jsonl'));
    older.appendMessage({ role: 'user', content: '旧的会话内容' });
    const newer = new TranscriptWriter(join(dir, 'bbb.jsonl'));
    newer.appendMessage({ role: 'user', content: '新的会话内容' });
    utimesSync(join(dir, 'aaa.jsonl'), new Date(1000), new Date(1000));
    utimesSync(join(dir, 'bbb.jsonl'), new Date(2000), new Date(2000));

    const sessions = listSessions('C:\\proj', root);

    expect(sessions.map((session) => session.sessionId)).toEqual(['bbb', 'aaa']);
    expect(sessions[0]!.summary).toBe('新的会话内容');
    expect(sessions[1]!.filePath).toBe(join(dir, 'aaa.jsonl'));
  });

  it('目录不存在返回空', () => {
    expect(listSessions('C:\\nope', root)).toEqual([]);
  });
});

describe('resumeSession', () => {
  it('重建 messages 历史（meta 行跳过），sessionId 取自文件名', () => {
    const filePath = join(root, 'r1.jsonl');
    const writer = new TranscriptWriter(filePath);
    writer.append('meta', { sessionId: 'r1' });
    writer.appendMessage({ role: 'user', content: 'q' });
    writer.appendMessage({
      role: 'assistant',
      content: 'a',
      toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}' }],
    });
    writer.appendMessage({ role: 'tool', toolCallId: 'c1', name: 'bash', content: 'out' });

    const resumed = resumeSession(filePath);

    expect(resumed.sessionId).toBe('r1');
    expect(resumed.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(resumed.messages[2]).toEqual({ role: 'tool', toolCallId: 'c1', name: 'bash', content: 'out' });
  });

  it('文件不存在抛错', () => {
    expect(() => resumeSession(join(root, 'missing.jsonl'))).toThrow('会话文件不存在');
  });
});

describe('resumeSession 压缩检查点', () => {
  const checkpoint = { kind: 'compact-checkpoint', beforeCount: 2, afterCount: 1, beforeTokens: 100, afterTokens: 10 };

  it('遇到 compact-checkpoint 丢弃此前历史，从摘要消息恢复', () => {
    const filePath = join(root, 'c1.jsonl');
    const writer = new TranscriptWriter(filePath);
    writer.append('meta', { sessionId: 'c1' });
    writer.appendMessage({ role: 'user', content: '旧问题' });
    writer.appendMessage({ role: 'assistant', content: '旧回答' });
    writer.append('meta', checkpoint);
    writer.appendMessage({ role: 'user', content: '[历史对话摘要]\n摘要' });
    writer.appendMessage({ role: 'user', content: '新问题' });
    writer.appendMessage({ role: 'assistant', content: '新回答' });

    const resumed = resumeSession(filePath);

    expect(resumed.messages.map((message) => message.content)).toEqual([
      '[历史对话摘要]\n摘要',
      '新问题',
      '新回答',
    ]);
  });

  it('多个 checkpoint 时以最后一个为准', () => {
    const filePath = join(root, 'c2.jsonl');
    const writer = new TranscriptWriter(filePath);
    writer.appendMessage({ role: 'user', content: 'q1' });
    writer.append('meta', checkpoint);
    writer.appendMessage({ role: 'user', content: '[历史对话摘要]\n摘要一' });
    writer.appendMessage({ role: 'assistant', content: 'a1' });
    writer.append('meta', checkpoint);
    writer.appendMessage({ role: 'user', content: '[历史对话摘要]\n摘要二' });
    writer.appendMessage({ role: 'assistant', content: 'a2' });

    const resumed = resumeSession(filePath);

    expect(resumed.messages.map((message) => message.content)).toEqual([
      '[历史对话摘要]\n摘要二',
      'a2',
    ]);
  });

  it('普通 SessionMeta 行不触发历史丢弃', () => {
    const filePath = join(root, 'c3.jsonl');
    const writer = new TranscriptWriter(filePath);
    writer.append('meta', { sessionId: 'c3', cwd: '/p', model: 'm', permissionMode: 'default', version: '0' });
    writer.appendMessage({ role: 'user', content: 'q' });
    writer.append('meta', { sessionId: 'c3', cwd: '/p', model: 'm', permissionMode: 'default', version: '0' });
    writer.appendMessage({ role: 'assistant', content: 'a' });

    const resumed = resumeSession(filePath);

    expect(resumed.messages.map((message) => message.content)).toEqual(['q', 'a']);
  });
});

describe('listSessions 头部读取', () => {
  it('大文件：首条 user 行在头部窗口内即可取到摘要，不整文件解析', () => {
    const dir = transcriptDirFor('C:\\big', root);
    mkdirSync(dir, { recursive: true });
    const writer = new TranscriptWriter(join(dir, 'big.jsonl'));
    writer.appendMessage({ role: 'user', content: '首条问题' });
    writer.appendMessage({ role: 'assistant', content: 'x'.repeat(256 * 1024) });

    const sessions = listSessions('C:\\big', root);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.summary).toBe('首条问题');
  });

  it('首条 user 行超出头部窗口时摘要为空（不回退整文件读取）', () => {
    const dir = transcriptDirFor('C:\\huge', root);
    mkdirSync(dir, { recursive: true });
    const writer = new TranscriptWriter(join(dir, 'huge.jsonl'));
    writer.appendMessage({ role: 'user', content: 'y'.repeat(16 * 1024) });

    const sessions = listSessions('C:\\huge', root);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.summary).toBe('');
  });
});

describe('TranscriptWriter 尾部读取', () => {
  it('末行超过尾部首窗时窗口翻倍，仍能续上 uuid 链', () => {
    const filePath = join(root, 'tail.jsonl');
    const first = new TranscriptWriter(filePath);
    first.appendMessage({ role: 'user', content: 'q' });
    const big = first.appendMessage({ role: 'assistant', content: 'x'.repeat(200 * 1024) });

    const second = new TranscriptWriter(filePath);
    const next = second.appendMessage({ role: 'user', content: '续' });

    expect(next.parentUuid).toBe(big.uuid);
  });
});
