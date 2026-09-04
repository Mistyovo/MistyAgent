import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentEvent } from '#/core/events';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { defineTool } from '#/core/tools/tool';
import type { AssistantMessage, StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

function makeDeps(
  provider: FakeProvider,
  events: AgentEvent[],
  overrides?: Partial<RunTurnDeps>,
): RunTurnDeps {
  return {
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    cwd,
    signal: new AbortController().signal,
    dispatchEvent: (event) => events.push(event),
    permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd }),
    ...overrides,
  };
}

/** finishReason='length' 的 done part；text 缺省表示本步未流出任何可见内容 */
function lengthStep(text?: string): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  if (text !== undefined) {
    parts.push({ type: 'text-delta', text });
  }
  parts.push({ type: 'done', usage: null, finishReason: 'length', rawFinishReason: 'length' });
  return parts;
}

const echoTool = defineTool({
  name: 'echo',
  description: '回显输入',
  inputSchema: z.object({ text: z.string() }),
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Echo ${input.text}`,
  call: (input) => Promise.resolve({ output: `echo:${input.text}` }),
});

describe('max_tokens 截断自动升级', () => {
  it('无输出截断 → maxTokens 翻倍重发：8192→16384→32768→65536', async () => {
    const provider = new FakeProvider([lengthStep(), lengthStep(), lengthStep(), textStep('ok')]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.maxTokens)).toEqual([8192, 16384, 32768, 65536]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // 截断的空尝试不留 assistant 消息
    expect(deps.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('升级封顶 65536 仍截断 → error 收尾（recoverable: false）', async () => {
    const provider = new FakeProvider([lengthStep(), lengthStep(), lengthStep(), lengthStep()]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('error');
    // 最多 3 次升级：4 次请求后熔断
    expect(provider.requests).toHaveLength(4);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.at(-1)).toMatchObject({ recoverable: false });
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'error' });
    expect(deps.messages).toHaveLength(1);
  });

  it('初始值取 maxTokens 配置：4096 截断后升到 8192', async () => {
    const provider = new FakeProvider([lengthStep(), textStep('ok')]);
    const deps = makeDeps(provider, [], { maxTokens: 4096 });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.maxTokens)).toEqual([4096, 8192]);
  });

  it('已流出部分文本后截断：不重试（避免重复上屏），turn 照常完成', async () => {
    const provider = new FakeProvider([lengthStep('半截输出'), textStep('must-not-be-used')]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const assistant = deps.messages[1] as AssistantMessage;
    expect(assistant.content).toBe('半截输出');
  });

  it('流出 reasoning 后截断同样不重试（reasoning 也是可见内容）', async () => {
    const provider = new FakeProvider([
      [
        { type: 'reasoning-delta', text: '思考到一半' },
        { type: 'done', usage: null, finishReason: 'length', rawFinishReason: 'length' },
      ],
      textStep('must-not-be-used'),
    ]);
    const deps = makeDeps(provider, []);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests).toHaveLength(1);
  });

  it('升级后的 maxTokens 被同 turn 后续 step 沿用（不回落）', async () => {
    const provider = new FakeProvider([
      lengthStep(),
      toolCallStep([{ name: 'echo', arguments: '{"text":"hi"}' }]),
      textStep('done'),
    ]);
    const deps = makeDeps(provider, [], { tools: [echoTool] });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(provider.requests.map((r) => r.maxTokens)).toEqual([8192, 16384, 16384]);
  });
});
