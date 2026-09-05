import { describe, expect, it } from 'vitest';

import { TaskBoard } from '#/core/board';
import { TaskManager } from '#/core/tasks';
import { createAgentTool } from '#/core/tools/builtin/agent';
import type { ToolContext } from '#/core/tools/tool';

import { FakeProvider, textStep } from './fake-provider';

const cwd = process.cwd();

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd, signal: signal ?? new AbortController().signal };
}

describe('agent 工具（共享证据板）', () => {
  it('board 非空时子代理 systemPrompt 含协作纪律段与板内容快照', async () => {
    const board = new TaskBoard();
    board.add('fact', 'foo 定义在 a.ts:1', 'Agent(explore)');
    board.add('deadend', '改配置中心方向已排除', 'Agent(plan)');
    const provider = new FakeProvider([textStep('结论')]);
    const tool = createAgentTool({ provider, getModel: () => 'm', board });

    await tool.call({ description: 'd', prompt: 'p', subagent_type: 'explore' }, ctx());

    const systemPrompt = provider.requests[0]!.systemPrompt;
    expect(systemPrompt).toContain('共享证据板');
    expect(systemPrompt).toContain('VERIFIED_FACT:');
    expect(systemPrompt).toContain('DEADEND:');
    expect(systemPrompt).toContain('已确认的事实：');
    expect(systemPrompt).toContain('- foo 定义在 a.ts:1（Agent(explore)）');
    expect(systemPrompt).toContain('已排除的方向（不要重复尝试）：');
    expect(systemPrompt).toContain('- 改配置中心方向已排除（Agent(plan)）');
  });

  it('board 为空时只有纪律段，不附板内容分节', async () => {
    const board = new TaskBoard();
    const provider = new FakeProvider([textStep('结论')]);
    const tool = createAgentTool({ provider, getModel: () => 'm', board });

    await tool.call({ description: 'd', prompt: 'p', subagent_type: 'explore' }, ctx());

    const systemPrompt = provider.requests[0]!.systemPrompt;
    expect(systemPrompt).toContain('共享证据板');
    expect(systemPrompt).not.toContain('已确认的事实：');
  });

  it('宿主不提供 board 时 systemPrompt 不含纪律段（现状回归）', async () => {
    const provider = new FakeProvider([textStep('结论')]);
    const tool = createAgentTool({ provider, getModel: () => 'm' });

    await tool.call({ description: 'd', prompt: 'p', subagent_type: 'explore' }, ctx());

    expect(provider.requests[0]!.systemPrompt).not.toContain('共享证据板');
  });

  it('结论中的 VERIFIED_FACT / DEADEND 行被收割进 board（来源标注 Agent(type)）', async () => {
    const board = new TaskBoard();
    const provider = new FakeProvider([
      textStep('结论：定位完成。\nVERIFIED_FACT: foo 在 a.ts:1\nDEADEND: 走 b.ts 方向不通'),
    ]);
    const tool = createAgentTool({ provider, getModel: () => 'm', board });

    const result = await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(board.entries()).toEqual([
      expect.objectContaining({ kind: 'fact', text: 'foo 在 a.ts:1', source: 'Agent(explore)' }),
      expect.objectContaining({ kind: 'deadend', text: '走 b.ts 方向不通', source: 'Agent(explore)' }),
    ]);
  });

  it('批量模式：两个子代理的收割都进同一 board', async () => {
    const board = new TaskBoard();
    const provider = new FakeProvider([
      textStep('结论A\nVERIFIED_FACT: 事实A'),
      textStep('结论B\nDEADEND: 方向B'),
    ]);
    const tool = createAgentTool({ provider, getModel: () => 'm', board });

    const result = await tool.call(
      {
        tasks: [
          { description: '任务一', prompt: 'p1', subagent_type: 'explore' },
          { description: '任务二', prompt: 'p2', subagent_type: 'plan' },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(board.entries()).toEqual([
      expect.objectContaining({ kind: 'fact', text: '事实A', source: 'Agent(explore)' }),
      expect.objectContaining({ kind: 'deadend', text: '方向B', source: 'Agent(plan)' }),
    ]);
  });

  it('后台路径：settle 前对聚合 output 收割，去重后同一条只进板一次', async () => {
    const board = new TaskBoard();
    const manager = new TaskManager();
    const provider = new FakeProvider([textStep('结论\nVERIFIED_FACT: 后台事实')]);
    const tool = createAgentTool({ provider, getModel: () => 'm', tasks: manager, board });

    await tool.call(
      { description: 'd', prompt: 'p', subagent_type: 'explore', run_in_background: true },
      ctx(),
    );
    await manager.waitForSettled('task_1', 5000);

    // runSubagent 原文收割 + settle 前 output 收割，同一条去重后仅一条
    expect(board.entries()).toEqual([
      expect.objectContaining({ kind: 'fact', text: '后台事实', source: 'Agent(explore)' }),
    ]);
  });
});
