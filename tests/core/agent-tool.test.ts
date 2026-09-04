import { describe, expect, it, vi } from 'vitest';

import { TaskManager } from '#/core/tasks';
import { createAgentTool } from '#/core/tools/builtin/agent';
import { createTaskOutputTool, createTaskStopTool } from '#/core/tools/builtin/tasks';
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

describe('agent 工具（自定义子代理定义）', () => {
  const reviewer = {
    name: 'reviewer',
    description: '代码评审',
    prompt: '你是代码评审子代理，审查改动并输出问题清单。',
  };

  it('自定义类型：正文作 system prompt 角色段，默认只读工具集，description 进工具描述', async () => {
    const provider = new FakeProvider([textStep('评审结论：无问题')]);
    const tool = createAgentTool({ provider, getModel: () => 'sub-model', subagents: [reviewer] });

    const result = await tool.call(
      { description: '评审改动', prompt: '评审 src/', subagent_type: 'reviewer' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('评审结论：无问题');
    const first = provider.requests[0]!;
    expect(first.systemPrompt).toContain('你是代码评审子代理');
    expect(first.systemPrompt).toContain(cwd);
    expect(first.tools.map((t) => t.name).toSorted()).toEqual(['glob', 'grep', 'read']);
    expect(tool.description).toContain('- reviewer：代码评审');
  });

  it('tools 白名单与 model 覆盖生效；可写代理的 prompt 含审批说明', async () => {
    const provider = new FakeProvider([textStep('修复完成')]);
    const tool = createAgentTool({
      provider,
      getModel: () => 'main-model',
      subagents: [
        {
          name: 'fixer',
          description: '修 bug',
          tools: ['read', 'write'],
          model: 'strong-model',
          prompt: '你是修复子代理。',
        },
      ],
    });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'fixer' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const first = provider.requests[0]!;
    expect(first.model).toBe('strong-model');
    expect(first.tools.map((t) => t.name).toSorted()).toEqual(['read', 'write']);
    expect(first.systemPrompt).toContain('交互审批能力');
  });

  it('未知 subagent_type 返回 isError 并列出可用类型', async () => {
    const provider = new FakeProvider([]);
    const tool = createAgentTool({ provider, getModel: () => 'm', subagents: [reviewer] });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'nope' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('未知子代理类型：nope');
    expect(result.output).toContain('explore');
    expect(result.output).toContain('plan');
    expect(result.output).toContain('reviewer');
    expect(provider.requests).toHaveLength(0);
  });

  it('白名单含未知工具名时 isError 并列出可用工具', async () => {
    const provider = new FakeProvider([]);
    const tool = createAgentTool({
      provider,
      getModel: () => 'm',
      subagents: [{ name: 'bad', description: 'd', tools: ['read', 'nonexistent'], prompt: 'x。' }],
    });

    const result = await tool.call({ description: 'd', prompt: 'p', subagent_type: 'bad' }, ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('未知工具：nonexistent');
    expect(result.output).toContain('read');
  });

  it('写工具在 default 权限模式触发 ask：子代理无交互能力，自动拒绝并回喂', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'write', arguments: '{"path":"a.txt","content":"x"}' }]),
      textStep('写操作被拒，改为输出只读结论'),
    ]);
    const tool = createAgentTool({
      provider,
      getModel: () => 'm',
      subagents: [{ name: 'fixer', description: 'd', tools: ['read', 'write'], prompt: '修复子代理。' }],
      getPermissionContext: () => ({ mode: 'default', rules: [], sessionApprovals: [], cwd }),
    });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'fixer' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('写操作被拒，改为输出只读结论');
    const second = provider.requests[1]!;
    const toolMessage = second.messages.find((m) => m.role === 'tool')!;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('子代理没有交互审批能力');
  });
});

describe('agent 工具（后台子代理）', () => {
  it('run_in_background 立即返回 taskId；缓冲累积文本与工具摘要；task_output 取到最终结论', async () => {
    const manager = new TaskManager();
    const finished: { id: string; status: string; tail: string }[] = [];
    manager.onFinished((task, tail) => {
      finished.push({ id: task.id, status: task.status, tail });
    });
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"x.ts"}' }]),
      textStep('后台结论：foo 在 x.ts:1'),
    ]);
    const tool = createAgentTool({ provider, getModel: () => 'm', tasks: manager });

    const start = Date.now();
    const result = await tool.call(
      { description: '后台找 foo', prompt: 'foo 在哪？', subagent_type: 'explore', run_in_background: true },
      ctx(),
    );

    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('task_1');
    expect(result.output).toContain('task_output');
    expect(tool.describeCall({
      description: '后台找 foo', prompt: 'p', subagent_type: 'explore', run_in_background: true,
    })).toContain('Agent(后台 explore)');

    const settled = await manager.waitForSettled('task_1', 5000);
    expect(settled).toMatchObject({ kind: 'agent', status: 'completed', exitCode: 0 });
    const buffered = manager.output('task_1')!.output;
    expect(buffered).toContain('⏵ Read x.ts');
    expect(buffered).toContain('--- 最终结论 ---');
    expect(buffered).toContain('后台结论：foo 在 x.ts:1');
    expect(finished).toEqual([
      { id: 'task_1', status: 'completed', tail: expect.stringContaining('后台结论') },
    ]);

    const viewed = await createTaskOutputTool(manager).call({ taskId: 'task_1' }, ctx());
    expect(viewed.output).toContain('[agent:completed]');
    expect(viewed.output).toContain('后台结论');
  });

  it('task_stop 中断运行中的后台子代理：abort 级联、状态 killed', async () => {
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
    const manager = new TaskManager();
    const tool = createAgentTool({ provider: hanging, getModel: () => 'm', tasks: manager });

    await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore', run_in_background: true },
      ctx(),
    );
    await vi.waitFor(() => {
      expect(subStarted).toBe(true);
    });

    const stopped = await createTaskStopTool(manager).call({ taskId: 'task_1' }, ctx());
    expect(stopped.output).toContain('killed');
    expect(subAborted).toBe(true);
    expect(manager.get('task_1')?.status).toBe('killed');
  });

  it('与 bash 后台任务共存：id 共用递增序列、类型各自标注', async () => {
    const manager = new TaskManager();
    manager.start('echo bash-coexist', cwd);
    const provider = new FakeProvider([textStep('agent 结论')]);
    const tool = createAgentTool({ provider, getModel: () => 'm', tasks: manager });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'plan', run_in_background: true },
      ctx(),
    );
    expect(result.output).toContain('task_2');

    await manager.waitForSettled('task_2', 5000);
    expect(manager.get('task_1')?.kind).toBe('bash');
    expect(manager.get('task_2')).toMatchObject({ kind: 'agent', status: 'completed' });
    await manager.stop('task_1');
  });

  it('宿主缺 TaskManager 时 run_in_background 报错回喂', async () => {
    const provider = new FakeProvider([]);
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore', run_in_background: true },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('不支持后台子代理');
  });
});
