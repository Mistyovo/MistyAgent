import { describe, expect, it, vi } from 'vitest';

import { TaskManager } from '#/core/tasks';
import { createAgentTool } from '#/core/tools/builtin/agent';
import type { ToolContext } from '#/core/tools/tool';
import type { ChatParams, ChatProvider, Message, StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep } from './fake-provider';

const cwd = process.cwd();

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd, signal: signal ?? new AbortController().signal };
}

function makeTool(scripts: StreamedMessagePart[][]) {
  const provider = new FakeProvider(scripts);
  const tool = createAgentTool({ provider, getModel: () => 'sub-model' });
  return { provider, tool };
}

describe('agent 工具（tasks 并行批量）', () => {
  it('批量前台：子任务真正并发，结果按任务分节聚合；各自独立 runTurn', async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: { systemPrompt: string; messages: Message[] }[] = [];
    const provider: ChatProvider = {
      async *generate(params: ChatParams) {
        seen.push({ systemPrompt: params.systemPrompt, messages: params.messages });
        started += 1;
        if (started === 2) {
          release!();
        }
        // 若是串行执行，第一个 generate 永远等不到第二个启动 → 测试超时失败
        await bothStarted;
        const prompt = params.messages[0]!.content;
        yield { type: 'text-delta', text: `结论（${prompt}）` };
        yield { type: 'done', usage: null, finishReason: 'completed', rawFinishReason: 'stop' };
      },
    };
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    const result = await tool.call(
      {
        tasks: [
          { description: '找 foo', prompt: 'p-foo', subagent_type: 'explore' },
          { description: '规划', prompt: 'p-plan', subagent_type: 'plan' },
        ],
      },
      ctx(),
    );

    expect(started).toBe(2);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('## [1] explore · 找 foo\n结论（p-foo）');
    expect(result.output).toContain('## [2] plan · 规划\n结论（p-plan）');
    // 每个子任务仍是独立 runTurn：各自的消息数组与系统提示，不共享状态
    const exploreReq = seen.find((r) => r.systemPrompt.includes('代码探索子代理'))!;
    const planReq = seen.find((r) => r.systemPrompt.includes('实现规划子代理'))!;
    expect(exploreReq.messages[0]).toEqual({ role: 'user', content: 'p-foo' });
    expect(planReq.messages[0]).toEqual({ role: 'user', content: 'p-plan' });
    expect(exploreReq.messages).not.toBe(planReq.messages);
  });

  it('批量前台：部分失败只标该节 ✗，整体不报错', async () => {
    const { provider, tool } = makeTool([
      textStep('结论A：一切正常'),
      // 无文本结论 → 该任务失败
      [{ type: 'done', usage: null, finishReason: 'completed', rawFinishReason: 'stop' }],
    ]);

    const result = await tool.call(
      {
        tasks: [
          { description: '任务一', prompt: 'p1', subagent_type: 'explore' },
          { description: '任务二', prompt: 'p2', subagent_type: 'explore' },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('## [1] explore · 任务一\n结论A：一切正常');
    expect(result.output).toContain('## [2] explore · 任务二 ✗');
    expect(result.output).toContain('没有产出文本结论');
    expect(provider.requests).toHaveLength(2);
  });

  it('批量前台：未知 subagent_type 的该节直接报错，不启动子代理、不影响其他任务', async () => {
    const { provider, tool } = makeTool([textStep('结论A')]);

    const result = await tool.call(
      {
        tasks: [
          { description: '正常', prompt: 'p1', subagent_type: 'explore' },
          { description: '坏类型', prompt: 'p2', subagent_type: 'nope' },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('## [1] explore · 正常\n结论A');
    expect(result.output).toContain('## [2] nope · 坏类型 ✗');
    expect(result.output).toContain('未知子代理类型：nope');
    expect(provider.requests).toHaveLength(1);
  });

  it('批量前台：全部失败时整体 isError', async () => {
    const { provider, tool } = makeTool([]);

    const result = await tool.call(
      {
        tasks: [
          { description: '坏一', prompt: 'p1', subagent_type: 'nope1' },
          { description: '坏二', prompt: 'p2', subagent_type: 'nope2' },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('## [1] nope1 · 坏一 ✗');
    expect(result.output).toContain('## [2] nope2 · 坏二 ✗');
    expect(provider.requests).toHaveLength(0);
  });

  it('批量前台：父 signal abort 级联到全部子 loop', async () => {
    let started = 0;
    let aborted = 0;
    const hanging: ChatProvider = {
      async *generate(params: ChatParams) {
        started += 1;
        await new Promise<void>((resolve) => {
          params.signal?.addEventListener(
            'abort',
            () => {
              aborted += 1;
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
      {
        tasks: [
          { description: 'A', prompt: 'pa', subagent_type: 'explore' },
          { description: 'B', prompt: 'pb', subagent_type: 'plan' },
        ],
      },
      ctx(controller.signal),
    );
    await vi.waitFor(() => {
      expect(started).toBe(2);
    });
    controller.abort();
    const result = await promise;

    expect(aborted).toBe(2);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('## [1] explore · A ✗');
    expect(result.output).toContain('## [2] plan · B ✗');
  });

  it('tasks 与单发互斥：tasks 非空时走批量并忽略单发字段', async () => {
    const { provider, tool } = makeTool([textStep('批量结论')]);

    const result = await tool.call(
      {
        description: '单发描述',
        prompt: '单发 prompt',
        subagent_type: 'plan',
        tasks: [{ description: '批量任务', prompt: '批量 prompt', subagent_type: 'explore' }],
      },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('## [1] explore · 批量任务');
    expect(result.output).toContain('批量结论');
    expect(result.output).not.toContain('单发');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.messages).toEqual([{ role: 'user', content: '批量 prompt' }]);
    expect(provider.requests[0]!.systemPrompt).toContain('代码探索子代理');
  });

  it('单发模式缺任一必填字段 → isError 说明用法', async () => {
    const { provider, tool } = makeTool([]);

    const result = await tool.call({ description: 'd', subagent_type: 'explore' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('description');
    expect(result.output).toContain('prompt');
    expect(result.output).toContain('subagent_type');
    expect(result.output).toContain('tasks');
    expect(provider.requests).toHaveLength(0);
  });

  it('tasks 超过 8 个被 schema 拒绝', async () => {
    const { provider, tool } = makeTool([]);
    const tasks = Array.from({ length: 9 }, (_, i) => ({
      description: `t${i}`,
      prompt: 'p',
      subagent_type: 'explore',
    }));

    expect(() => tool.call({ tasks }, ctx())).toThrow();
    expect(provider.requests).toHaveLength(0);
  });
});

describe('agent 工具（tasks 批量后台）', () => {
  it('登记单个后台任务：内部并发跑，分节聚合文本 appendOutput 后 settle', async () => {
    const manager = new TaskManager();
    const finished: { id: string; status: string; tail: string }[] = [];
    manager.onFinished((task, tail) => {
      finished.push({ id: task.id, status: task.status, tail });
    });
    const provider = new FakeProvider([textStep('结论A'), textStep('结论B')]);
    const tool = createAgentTool({ provider, getModel: () => 'm', tasks: manager });

    const result = await tool.call(
      {
        tasks: [
          { description: '任务一', prompt: 'p1', subagent_type: 'explore' },
          { description: '任务二', prompt: 'p2', subagent_type: 'plan' },
        ],
        run_in_background: true,
      },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('task_1');
    expect(result.output).toContain('2 个任务');
    expect(
      tool.describeCall({
        tasks: [
          { description: '任务一', prompt: 'p1', subagent_type: 'explore' },
          { description: '任务二', prompt: 'p2', subagent_type: 'plan' },
        ],
      }),
    ).toBe('Agent(×2 parallel) 任务一 …');

    const settled = await manager.waitForSettled('task_1', 5000);
    expect(settled).toMatchObject({ kind: 'agent', status: 'completed', exitCode: 0 });
    const buffered = manager.output('task_1')!.output;
    expect(buffered).toContain('--- 最终结论 ---');
    expect(buffered).toContain('## [1] explore · 任务一');
    expect(buffered).toContain('结论A');
    expect(buffered).toContain('## [2] plan · 任务二');
    expect(buffered).toContain('结论B');
    expect(finished).toEqual([
      { id: 'task_1', status: 'completed', tail: expect.stringContaining('## [1] explore') },
    ]);
  });

  it('批量后台全部失败：任务 failed、exitCode 非 0', async () => {
    const manager = new TaskManager();
    const provider = new FakeProvider([]);
    const tool = createAgentTool({ provider, getModel: () => 'm', tasks: manager });

    await tool.call(
      {
        tasks: [{ description: '坏', prompt: 'p', subagent_type: 'nope' }],
        run_in_background: true,
      },
      ctx(),
    );

    const settled = await manager.waitForSettled('task_1', 5000);
    expect(settled).toMatchObject({ kind: 'agent', status: 'failed' });
    expect(manager.output('task_1')!.output).toContain('未知子代理类型：nope');
  });

  it('宿主缺 TaskManager 时批量后台报错回喂', async () => {
    const { provider, tool } = makeTool([]);

    const result = await tool.call(
      {
        tasks: [{ description: 'd', prompt: 'p', subagent_type: 'explore' }],
        run_in_background: true,
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('不支持后台子代理');
    expect(provider.requests).toHaveLength(0);
  });
});
