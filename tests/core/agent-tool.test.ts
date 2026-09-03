import { describe, expect, it, vi } from 'vitest';

import { createAgentTool } from '#/core/tools/builtin/agent';
import type { ToolContext } from '#/core/tools/tool';
import type { ChatProvider, ChatParams, StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd, signal: signal ?? new AbortController().signal };
}

function makeTool(scripts: StreamedMessagePart[][]) {
  const provider = new FakeProvider(scripts);
  const tool = createAgentTool({ provider, getModel: () => 'sub-model' });
  return { provider, tool };
}

describe('agent 工具（explore 子代理）', () => {
  it('独立消息历史 + 只读工具集 + 最终文本回传', async () => {
    const { provider, tool } = makeTool([
      toolCallStep([{ name: 'read', arguments: '{"path":"不存在的文件.txt"}' }]),
      textStep('探索结论：foo 定义在 a.ts:1'),
    ]);

    const result = await tool.call(
      { description: '找 foo', prompt: 'foo 定义在哪里？', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('探索结论：foo 定义在 a.ts:1');
    // 第一步：独立历史（只有子代理 prompt），只读工具集，独立 system prompt（含 cwd、不含 AGENTS.md）
    const first = provider.requests[0]!;
    expect(first.model).toBe('sub-model');
    expect(first.messages).toEqual([{ role: 'user', content: 'foo 定义在哪里？' }]);
    expect(first.tools.map((t) => t.name).toSorted()).toEqual(['glob', 'grep', 'read']);
    expect(first.systemPrompt).toContain('代码探索子代理');
    expect(first.systemPrompt).toContain(cwd);
    expect(first.systemPrompt).not.toContain('AGENTS.md');
    // 第二步：子 loop 内部消化了工具结果（isError 也回喂继续），主会话历史不参与
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('plan 子代理：规划 prompt + 同样的只读工具集', async () => {
    const { provider, tool } = makeTool([textStep('计划：第一步…')]);

    const result = await tool.call(
      { description: '规划重构', prompt: '给出重构计划', subagent_type: 'plan' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('计划：第一步…');
    expect(provider.requests[0]!.systemPrompt).toContain('实现规划子代理');
    expect(provider.requests[0]!.tools.map((t) => t.name).toSorted()).toEqual([
      'glob',
      'grep',
      'read',
    ]);
  });

  it('输出超过 30000 字符被截断', async () => {
    const { tool } = makeTool([textStep('x'.repeat(31_000))]);

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output.length).toBeLessThan(31_000);
    expect(result.output).toContain('截断');
  });

  it('子代理没有产出文本结论时返回 isError', async () => {
    const { tool } = makeTool([
      [{ type: 'done', usage: null, finishReason: 'completed', rawFinishReason: 'stop' }],
    ]);

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('没有产出文本结论');
  });

  it('父 signal abort 级联到子 loop', async () => {
    let subStarted = false;
    let subAborted = false;
    const hanging: ChatProvider = {
      async *generate(params: ChatParams) {
        subStarted = true;
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener(
            'abort',
            () => {
              subAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        yield { type: 'error', error: new Error('aborted') };
      },
    };
    const tool = createAgentTool({ provider: hanging, getModel: () => 'm' });
    const controller = new AbortController();

    const promise = tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(controller.signal),
    );
    await vi.waitFor(() => {
      expect(subStarted).toBe(true);
    });
    controller.abort();
    const result = await promise;

    expect(subAborted).toBe(true);
    expect(result.isError).toBe(true);
  });
});
