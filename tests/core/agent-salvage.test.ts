import { describe, expect, it } from 'vitest';

import { createAgentTool } from '#/core/tools/builtin/agent';
import type { ToolContext } from '#/core/tools/tool';
import type { ChatProvider, StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd, signal: signal ?? new AbortController().signal };
}

/** 流以不可重试错误收尾（boom 不匹配任何可重试模式，chatWithRetry 透传不多消耗 script） */
function errorStep(): StreamedMessagePart[] {
  return [{ type: 'error', error: new Error('boom') }];
}

/** 无文本、无工具调用的空收尾 */
function emptyStep(): StreamedMessagePart[] {
  return [{ type: 'done', usage: null, finishReason: 'completed', rawFinishReason: 'stop' }];
}

describe('agent 工具（烂尾救援 salvage）', () => {
  it('error 收官且无文本：沿同一 messages 续跑收尾轮，结果带前缀说明、收尾轮 tools 为空', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"不存在的文件.txt"}' }]),
      errorStep(),
      textStep('收尾总结：已确认 foo 在 a.ts:1'),
    ]);
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe(
      'The subagent did not wrap up normally; the following is its salvage summary\n收尾总结：已确认 foo 在 a.ts:1',
    );
    expect(provider.requests).toHaveLength(3);
    // 收尾轮：同一消息历史续跑（初始 prompt + 探索轨迹 + 收尾指令），工具为空
    const salvage = provider.requests[2]!;
    expect(salvage.tools).toEqual([]);
    expect(salvage.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(salvage.messages[0]).toEqual({ role: 'user', content: 'p' });
    const last = salvage.messages[3]!;
    expect(last.role).toBe('user');
    expect(last.role === 'user' && last.content).toContain('stop exploring immediately');
    expect(last.role === 'user' && last.content).toContain('do not call any tool');
    expect(last.role === 'user' && last.content).toContain('unverified');
  });

  it('completed 烂尾（有工具历史但无文本）同样救援，但不加前缀', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"不存在的文件.txt"}' }]),
      emptyStep(),
      textStep('收尾文本'),
    ]);
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('收尾文本');
    expect(provider.requests[2]!.tools).toEqual([]);
  });

  it('救援轮仍无文本：走原 isError 路径', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"不存在的文件.txt"}' }]),
      errorStep(),
      emptyStep(),
    ]);
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('The subagent produced no text conclusion');
    expect(provider.requests).toHaveLength(3);
  });

  it('interrupted 不救：用户主动中断直接按部分结果处理', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: ChatProvider = {
      async *generate() {
        calls += 1;
        if (calls === 1) {
          yield { type: 'tool-call-start', index: 0, id: 'call_0', name: 'read' };
          yield { type: 'tool-call-delta', index: 0, argumentsDelta: '{"path":"x.ts"}' };
          yield { type: 'done', usage: null, finishReason: 'tool-calls', rawFinishReason: 'tool_calls' };
          return;
        }
        // 第二步模拟用户中断：abort 后流出空收尾 → stopReason interrupted
        controller.abort();
        yield { type: 'done', usage: null, finishReason: 'completed', rawFinishReason: 'stop' };
      },
    };
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(controller.signal),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stopReason: interrupted');
    // 没有触发救援轮
    expect(calls).toBe(2);
  });

  it('首条即空回复（无探索历史）不救：messages 只有初始 prompt', async () => {
    const provider = new FakeProvider([emptyStep()]);
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('The subagent produced no text conclusion');
    expect(provider.requests).toHaveLength(1);
  });
});
