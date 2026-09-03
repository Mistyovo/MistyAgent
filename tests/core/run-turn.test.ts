import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentEvent } from '#/core/events';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { builtinTools } from '#/core/tools/builtin/index';
import { defineTool, type Tool, type ToolContext } from '#/core/tools/tool';
import type { AssistantMessage, ToolMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

function makeDeps(
  provider: FakeProvider,
  tools: Tool[],
  events: AgentEvent[],
  overrides?: Partial<RunTurnDeps>,
): RunTurnDeps {
  const effectiveCwd = overrides?.cwd ?? cwd;
  return {
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    cwd: effectiveCwd,
    signal: new AbortController().signal,
    dispatchEvent: (event) => events.push(event),
    // 与权限无关的用例默认全部放行
    permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd: effectiveCwd }),
    ...overrides,
  };
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

describe('runTurn', () => {
  it('纯文本一步结束', async () => {
    const provider = new FakeProvider([textStep('你好', { inputTokens: 3, outputTokens: 2 })]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [], events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(deps.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((deps.messages[1] as AssistantMessage).content).toBe('你好');
    expect(events.map((e) => e.type)).toEqual([
      'turn-started',
      'text-delta',
      'step-finished',
      'turn-complete',
    ]);
  });

  it('工具调用 → 结果回喂 → 文本结束', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'echo', arguments: '{"text":"hi"}' }]),
      textStep('done', { inputTokens: 10, outputTokens: 1 }),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [echoTool], events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(deps.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const assistant = deps.messages[1] as AssistantMessage;
    expect(assistant.toolCalls).toHaveLength(1);
    const toolMessage = deps.messages[2] as ToolMessage;
    expect(toolMessage.toolCallId).toBe('call_0');
    expect(toolMessage.content).toBe('echo:hi');
    expect(toolMessage.isError).toBeUndefined();
    // 第二步请求带上了工具结果
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool-call-started');
    expect(types).toContain('tool-call-completed');
    expect(types.filter((t) => t === 'step-finished')).toHaveLength(2);
  });

  it('连续只读调用并发执行，写调用串行等待', async () => {
    const log: string[] = [];
    const gate = (label: string) => {
      let release!: () => void;
      const tool = defineTool({
        name: label,
        description: label,
        inputSchema: z.object({}),
        isReadOnly: () => label !== 'c',
        accesses: () => (label === 'c' ? [{ kind: 'write' as const }] : [{ kind: 'read' as const }]),
        call: () => {
          log.push(`${label}:start`);
          return new Promise((resolve) => {
            release = () => {
              log.push(`${label}:end`);
              resolve({ output: label });
            };
          });
        },
      });
      return { tool, release: () => release() };
    };
    const a = gate('a');
    const b = gate('b');
    const c = gate('c');
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'a', arguments: '{}' },
        { name: 'b', arguments: '{}' },
        { name: 'c', arguments: '{}' },
      ]),
      textStep('ok'),
    ]);
    const deps = makeDeps(provider, [a.tool, b.tool, c.tool], []);

    const resultPromise = runTurn(deps);
    await vi.waitFor(() => {
      expect(log).toContain('a:start');
      expect(log).toContain('b:start');
    });
    expect(log).not.toContain('c:start');
    a.release();
    b.release();
    await vi.waitFor(() => {
      expect(log).toContain('c:start');
    });
    expect(log.indexOf('c:start')).toBeGreaterThan(log.indexOf('a:end'));
    expect(log.indexOf('c:start')).toBeGreaterThan(log.indexOf('b:end'));
    c.release();

    const result = await resultPromise;
    expect(result.stopReason).toBe('completed');
    expect(deps.messages.filter((m) => m.role === 'tool')).toHaveLength(3);
  });

  it('中断时给未执行的 toolCalls 补合成 isError tool 消息', async () => {
    const log: string[] = [];
    const slowTool = defineTool({
      name: 'slow',
      description: '慢写操作',
      inputSchema: z.object({}),
      accesses: () => [{ kind: 'write' }],
      call: (_input, ctx: ToolContext) => {
        log.push('slow:start');
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
    });
    const neverTool = defineTool({
      name: 'never',
      description: '排不到的操作',
      inputSchema: z.object({}),
      accesses: () => [{ kind: 'write' }],
      call: () => {
        log.push('never:start');
        return Promise.resolve({ output: 'never' });
      },
    });
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'slow', arguments: '{}' },
        { name: 'never', arguments: '{}' },
      ]),
    ]);
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const deps = makeDeps(provider, [slowTool, neverTool], events, { signal: controller.signal });

    const resultPromise = runTurn(deps);
    await vi.waitFor(() => {
      expect(log).toContain('slow:start');
    });
    controller.abort();
    const result = await resultPromise;

    expect(result.stopReason).toBe('interrupted');
    expect(log).not.toContain('never:start');
    expect(provider.requests).toHaveLength(1);
    expect(deps.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    const interruptedTool = deps.messages[3] as ToolMessage;
    expect(interruptedTool.name).toBe('never');
    expect(interruptedTool.isError).toBe(true);
    expect(interruptedTool.content).toBe('interrupted by user');
    expect(events.some((e) => e.type === 'interrupted' && e.reason === 'user')).toBe(true);
    expect(events.at(-1)?.type).toBe('turn-complete');
  });

  it('达到 maxSteps 时注入提示消息并以无工具的最后一步收尾', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'echo', arguments: '{"text":"1"}' }]),
      toolCallStep([{ name: 'echo', arguments: '{"text":"2"}' }]),
      textStep('总结收尾'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [echoTool], events, { maxSteps: 2 });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('max-steps');
    expect(result.steps).toBe(3);
    // 最后一步不带工具定义
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]!.tools).toEqual([]);
    const roles = deps.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'user', 'assistant']);
    const hint = deps.messages[5]!;
    expect(hint.role).toBe('user');
    expect((hint as { content: string }).content).toContain('最大步数');
    expect((deps.messages[6] as AssistantMessage).content).toBe('总结收尾');
  });

  it('工具抛异常转为 isError 结果回喂，loop 继续', async () => {
    const boomTool = defineTool({
      name: 'boom',
      description: '总是抛异常',
      inputSchema: z.object({}),
      call: () => {
        throw new Error('kaboom');
      },
    });
    const provider = new FakeProvider([
      toolCallStep([{ name: 'boom', arguments: '{}' }]),
      textStep('recovered'),
    ]);
    const deps = makeDeps(provider, [boomTool], []);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    const toolMessage = deps.messages[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('kaboom');
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('未知工具与非法 JSON 参数转为 isError 结果', async () => {
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'missing', arguments: '{}' },
        { name: 'echo', arguments: '{not json' },
      ]),
      textStep('ok'),
    ]);
    const deps = makeDeps(provider, [echoTool], []);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    const toolMessages = deps.messages.filter((m) => m.role === 'tool') as ToolMessage[];
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]!.content).toContain('未知工具');
    expect(toolMessages[0]!.isError).toBe(true);
    expect(toolMessages[1]!.content).toContain('JSON');
    expect(toolMessages[1]!.isError).toBe(true);
  });

  it('provider 错误（重试耗尽）以 error 事件结束 turn', async () => {
    const provider = new FakeProvider([
      [{ type: 'error', error: Object.assign(new Error('bad request'), { status: 400 }) }],
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [], events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('error');
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toMatchObject({ message: 'bad request', recoverable: false });
    expect(events.at(-1)).toMatchObject({ type: 'turn-complete', stopReason: 'error' });
    // 没有内容的 assistant 消息不进历史
    expect(deps.messages).toHaveLength(1);
  });

  it('loop 驱动真实内置工具（read）完成一轮', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'misty-loop-'));
    await writeFile(path.join(dir, 'demo.txt'), 'alpha\nbeta\n', 'utf8');
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"demo.txt"}' }]),
      textStep('读完了'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, builtinTools, events, { cwd: dir });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    const toolMessage = deps.messages[2] as ToolMessage;
    expect(toolMessage.content).toBe('1\talpha\n2\tbeta\n3\t');
    const completed = events.find((e) => e.type === 'tool-call-completed');
    expect(completed).toMatchObject({ name: 'read', isError: false });
    expect(deps.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
});
