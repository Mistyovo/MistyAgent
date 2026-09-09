import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Session } from '#/core/session/session';
import { writeTool } from '#/core/tools/builtin/write';
import type { Tool } from '#/core/tools/tool';

import { FakeProvider, textStep, toolCallStep, type RecordedRequest } from './fake-provider';

const MEMORY_FILE_CONTENT = `---
description: 用户角色与偏好
type: user
---

用户是资深前端工程师，偏爱简洁直接的方案。
`;

/** 召回选择调用的特征：tools 为空数组、maxTokens 256（见 memory/recall.ts） */
function recallRequests(provider: FakeProvider): RecordedRequest[] {
  return provider.requests.filter((r) => r.maxTokens === 256 && r.tools.length === 0);
}

/** 提取子代理调用的特征：systemPrompt 由 memory/extract.ts 组装 */
function extractionRequests(provider: FakeProvider): RecordedRequest[] {
  return provider.requests.filter((r) => r.systemPrompt.includes('memory extraction subagent'));
}

/** 主循环调用：systemPrompt 即 Session 配置的 'system' */
function mainRequests(provider: FakeProvider): RecordedRequest[] {
  return provider.requests.filter((r) => r.systemPrompt === 'system');
}

describe('Session 记忆接线', () => {
  let root: string;
  let memoryDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'misty-session-memory-'));
    memoryDir = join(root, 'memory');
    mkdirSync(memoryDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeSession(provider: FakeProvider, tools: Tool[] = []): Session {
    return new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools,
      cwd: root,
      permission: { mode: 'bypassPermissions' },
      memory: { enabled: true, dir: memoryDir },
    });
  }

  it('召回命中：user 消息被 prepend <recalled-memories>，同一记忆不重复召回', async () => {
    writeFileSync(join(memoryDir, 'user_role.md'), MEMORY_FILE_CONTENT);
    const provider = new FakeProvider([
      // 1. 召回选择：选中唯一的记忆文件
      textStep('{"selected": ["user_role.md"]}'),
      // 2. 主循环
      textStep('主回答'),
      // 3. turn 结束后的后台提取（无值得写的内容，直接文本收尾）
      textStep('没有值得保存的内容'),
      // 4. 第二个 turn 的主循环（记忆已 surfaced，召回选择不再发起）
      textStep('第二回答'),
    ]);
    const session = makeSession(provider);

    const result = await session.submit({ type: 'user-turn', text: '帮我写个组件' });

    expect(result.stopReason).toBe('completed');
    expect(recallRequests(provider)).toHaveLength(1);
    // 主循环拿到的 user 消息带召回块，原文在块之后
    const userText = mainRequests(provider).at(-1)!.messages.at(-1)!.content;
    expect(userText.startsWith('<recalled-memories>\n')).toBe(true);
    expect(userText).toContain('=== user_role.md ===');
    expect(userText).toContain('用户是资深前端工程师');
    expect(userText.endsWith('</recalled-memories>\n\n帮我写个组件')).toBe(true);
    // 会话历史里的 user 消息同样是 prepend 后的文本
    expect(session.getMessages()[0]!.content).toBe(userText);

    // 等后台提取落定（消耗第 3 个脚本），避免与第二个 turn 抢脚本顺序
    await vi.waitFor(() => {
      expect(extractionRequests(provider)).toHaveLength(1);
    });

    await session.submit({ type: 'user-turn', text: '再来一个' });

    // 同一记忆已 surfaced：不再发起召回选择，user 消息原样进主循环
    expect(recallRequests(provider)).toHaveLength(1);
    expect(mainRequests(provider).at(-1)!.messages.at(-1)!.content).toBe('再来一个');
  });

  it('无记忆时不发起召回选择，user 消息原样进入主循环', async () => {
    const provider = new FakeProvider([textStep('回答')]);
    const session = makeSession(provider);

    await session.submit({ type: 'user-turn', text: 'hello' });

    expect(recallRequests(provider)).toHaveLength(0);
    expect(mainRequests(provider)).toHaveLength(1);
    expect(mainRequests(provider)[0]!.messages.at(-1)!.content).toBe('hello');
  });

  it('turn 正常完成后后台触发记忆提取，提取代理写入新记忆文件', async () => {
    const provider = new FakeProvider([
      // 1. 主循环（记忆目录为空，召回选择不发起）
      textStep('主回答'),
      // 2. 提取子代理：写入新记忆文件
      toolCallStep([
        {
          name: 'write',
          arguments: JSON.stringify({
            path: join(memoryDir, 'project_misty.md'),
            content: '---\ndescription: MistyAgent 项目约定\n---\n本项目用 vitest 做测试。\n',
          }),
        },
      ]),
      // 3. 提取子代理收尾
      textStep('提取完成'),
    ]);
    const session = makeSession(provider);

    const result = await session.submit({ type: 'user-turn', text: '记一下这个项目用 vitest' });

    expect(result.stopReason).toBe('completed');
    await vi.waitFor(() => {
      expect(readdirSync(memoryDir)).toContain('project_misty.md');
    });
    // 提取 turn 的每个 step 都是一个请求（写工具 + 文本收尾）
    expect(extractionRequests(provider).length).toBeGreaterThan(0);
    expect(extractionRequests(provider)[0]!.tools.map((t) => t.name)).toContain('write');
  });

  it('主 agent 在 turn 内自己写过记忆目录时跳过提取', async () => {
    const provider = new FakeProvider([
      // 1. 主循环：主 agent 自己写记忆
      toolCallStep([
        {
          name: 'write',
          arguments: JSON.stringify({
            path: join(memoryDir, 'self_note.md'),
            content: '---\ndescription: 主代理自记\n---\n内容\n',
          }),
        },
      ]),
      // 2. 主循环收尾
      textStep('写完了'),
    ]);
    const session = makeSession(provider, [writeTool]);

    const result = await session.submit({ type: 'user-turn', text: '把这个记到记忆里' });

    expect(result.stopReason).toBe('completed');
    expect(readdirSync(memoryDir)).toContain('self_note.md');
    // 等一拍确认提取确实没有启动（提取链无真实定时器，50ms 足够）
    await new Promise((r) => setTimeout(r, 50));
    expect(extractionRequests(provider)).toHaveLength(0);
  });

  it('memory 未开启时不召回也不提取', async () => {
    writeFileSync(join(memoryDir, 'user_role.md'), MEMORY_FILE_CONTENT);
    const provider = new FakeProvider([textStep('回答')]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: [],
      cwd: root,
      permission: { mode: 'bypassPermissions' },
    });

    await session.submit({ type: 'user-turn', text: 'hello' });

    await new Promise((r) => setTimeout(r, 50));
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.messages.at(-1)!.content).toBe('hello');
  });
});
