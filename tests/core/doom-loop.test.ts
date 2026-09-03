import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentEvent, ApprovalRequestedEvent } from '#/core/events';
import { DoomLoopDetector } from '#/core/loop/doom-loop';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { defineTool, type Tool } from '#/core/tools/tool';
import type { ToolMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

const SAME_ARGS = '{"text":"x"}';

function sameCallStep(id: string) {
  return toolCallStep([{ name: 'echo', arguments: SAME_ARGS, id }]);
}

function makeDeps(
  provider: FakeProvider,
  tools: Tool[],
  events: AgentEvent[],
  overrides?: Partial<RunTurnDeps>,
): RunTurnDeps {
  return {
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    cwd,
    signal: new AbortController().signal,
    dispatchEvent: (event) => events.push(event),
    permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd }),
    ...overrides,
  };
}

function approvalRequests(events: AgentEvent[]): ApprovalRequestedEvent[] {
  return events.filter((e): e is ApprovalRequestedEvent => e.type === 'approval-requested');
}

function toolMessages(deps: RunTurnDeps): ToolMessage[] {
  return deps.messages.filter((m) => m.role === 'tool') as ToolMessage[];
}

function makeEcho(executed: string[]): Tool {
  return defineTool({
    name: 'echo',
    description: '回显输入',
    inputSchema: z.object({ text: z.string() }),
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    call: (input) => {
      executed.push(input.text);
      return Promise.resolve({ output: `echo:${input.text}` });
    },
  });
}

describe('DoomLoopDetector', () => {
  it('连续 3 次完全相同调用触发，之后保持触发', () => {
    const detector = new DoomLoopDetector();
    expect(detector.record('read', '{"path":"a"}')).toBe(false);
    expect(detector.record('read', '{"path":"a"}')).toBe(false);
    expect(detector.record('read', '{"path":"a"}')).toBe(true);
    expect(detector.record('read', '{"path":"a"}')).toBe(true);
  });

  it('参数不同或工具不同都会重置连续计数', () => {
    const detector = new DoomLoopDetector();
    expect(detector.record('read', '{"path":"a"}')).toBe(false);
    expect(detector.record('read', '{"path":"b"}')).toBe(false);
    expect(detector.record('read', '{"path":"a"}')).toBe(false);
    expect(detector.record('grep', '{"path":"a"}')).toBe(false);
    expect(detector.record('grep', '{"path":"a"}')).toBe(false);
    expect(detector.record('grep', '{"path":"a"}')).toBe(true);
  });
});

describe('doom-loop 防护（runTurn 集成）', () => {
  it('连续第 3 次相同调用升级为审批（bypass 模式也不例外），reject 回喂 isError', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      sameCallStep('c1'),
      sameCallStep('c2'),
      sameCallStep('c3'),
      textStep('换思路了'),
    ]);
    const events: AgentEvent[] = [];
    const permission = createPermissionRuntime({ mode: 'bypassPermissions', cwd });
    const deps = makeDeps(provider, [makeEcho(executed)], events, {
      permission,
      dispatchEvent: (event) => {
        events.push(event);
        if (event.type === 'approval-requested') {
          permission.approvals.reply(event.request.id, {
            decision: 'reject',
            feedback: '别再重复同样的调用',
          });
        }
      },
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    // 前两次正常执行，第三次被审批拦截
    expect(executed).toEqual(['x', 'x']);
    const requests = approvalRequests(events);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.reason).toContain('重复调用循环');
    expect(requests[0]!.request.toolName).toBe('echo');
    const messages = toolMessages(deps);
    expect(messages).toHaveLength(3);
    expect(messages[2]!.isError).toBe(true);
    expect(messages[2]!.content).toContain('用户拒绝');
    expect(messages[2]!.content).toContain('别再重复同样的调用');
  });

  it('审批放行后第三次照常执行', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      sameCallStep('c1'),
      sameCallStep('c2'),
      sameCallStep('c3'),
      textStep('done'),
    ]);
    const events: AgentEvent[] = [];
    const permission = createPermissionRuntime({ mode: 'bypassPermissions', cwd });
    const deps = makeDeps(provider, [makeEcho(executed)], events, {
      permission,
      dispatchEvent: (event) => {
        events.push(event);
        if (event.type === 'approval-requested') {
          permission.approvals.reply(event.request.id, { decision: 'once' });
        }
      },
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(executed).toEqual(['x', 'x', 'x']);
    expect(approvalRequests(events)).toHaveLength(1);
    expect(toolMessages(deps).every((m) => m.isError === undefined)).toBe(true);
  });

  it('参数各不相同的连续调用不触发审批', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'echo', arguments: '{"text":"1"}', id: 'c1' }]),
      toolCallStep([{ name: 'echo', arguments: '{"text":"2"}', id: 'c2' }]),
      toolCallStep([{ name: 'echo', arguments: '{"text":"3"}', id: 'c3' }]),
      textStep('done'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [makeEcho(executed)], events);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(executed).toEqual(['1', '2', '3']);
    expect(approvalRequests(events)).toHaveLength(0);
  });
});
