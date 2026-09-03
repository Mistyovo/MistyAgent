import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { PermissionMode, PermissionRule } from '#/config/schema';
import type { AgentEvent, ApprovalRequestedEvent } from '#/core/events';
import { Session } from '#/core/session/session';
import { writeTool } from '#/core/tools/builtin/write';
import { defineTool, type Tool } from '#/core/tools/tool';
import type { ToolMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

function makeSession(
  provider: FakeProvider,
  tools: Tool[],
  permission: { mode?: PermissionMode; rules?: PermissionRule[] },
  sessionCwd: string = cwd,
): Session {
  return new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools,
    cwd: sessionCwd,
    permission,
  });
}

function stubBash(executed: string[]): Tool {
  return defineTool({
    name: 'bash',
    description: '记录命令的 stub bash',
    inputSchema: z.object({ command: z.string(), timeout: z.number().optional() }),
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) => `Bash ${input.command}`,
    call: (input) => {
      executed.push(input.command);
      return Promise.resolve({ output: `ran:${input.command}` });
    },
  });
}

function approvalRequests(events: AgentEvent[]): ApprovalRequestedEvent[] {
  return events.filter((e): e is ApprovalRequestedEvent => e.type === 'approval-requested');
}

describe('权限接线：loop 与 session', () => {
  it('default 模式 bash 触发审批，once 后执行并回喂结果', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'bash', arguments: '{"command":"git status"}' }]),
      textStep('done'),
    ]);
    const session = makeSession(provider, [stubBash(executed)], { mode: 'default' });
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
      if (event.type === 'approval-requested') {
        // 监听器同步回复：审批必须先挂起再发事件
        session.submit({ type: 'approval-reply', id: event.request.id, reply: { decision: 'once' } });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(executed).toEqual(['git status']);
    expect(approvalRequests(events)).toHaveLength(1);
    expect(approvalRequests(events)[0]!.request).toMatchObject({
      id: 'call_0',
      toolName: 'bash',
      describeCall: 'Bash git status',
    });
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.content).toBe('ran:git status');
    expect(toolMessage.isError).toBeUndefined();
  });

  it('审批 reject：工具不执行，isError 与 feedback 回喂模型', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'bash', arguments: '{"command":"rm -rf x"}' }]),
      textStep('好的，不执行'),
    ]);
    const session = makeSession(provider, [stubBash(executed)], { mode: 'default' });
    session.onEvent((event) => {
      if (event.type === 'approval-requested') {
        session.submit({
          type: 'approval-reply',
          id: event.request.id,
          reply: { decision: 'reject', feedback: '太危险了' },
        });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(executed).toEqual([]);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('用户拒绝');
    expect(toolMessage.content).toContain('太危险了');
    // 拒绝结果进入了下一步请求的历史
    expect(provider.requests[1]!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('always 写会话规则：同首词命令后续 turn 不再审批', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'bash', arguments: '{"command":"git status"}' }]),
      textStep('t1'),
      toolCallStep([{ name: 'bash', arguments: '{"command":"git push"}' }]),
      textStep('t2'),
    ]);
    const session = makeSession(provider, [stubBash(executed)], { mode: 'default' });
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
      if (event.type === 'approval-requested') {
        session.submit({ type: 'approval-reply', id: event.request.id, reply: { decision: 'always' } });
      }
    });

    await session.submit({ type: 'user-turn', text: 'first' });
    await session.submit({ type: 'user-turn', text: 'second' });

    expect(executed).toEqual(['git status', 'git push']);
    expect(approvalRequests(events)).toHaveLength(1);
  });

  it('plan 模式 write 直接拒绝：不弹审批、文件不落地', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'misty-perm-'));
    const provider = new FakeProvider([
      toolCallStep([{ name: 'write', arguments: '{"path":"a.txt","content":"hi"}' }]),
      textStep('明白，只给方案'),
    ]);
    const session = makeSession(provider, [writeTool], { mode: 'plan' }, dir);
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(approvalRequests(events)).toHaveLength(0);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('plan');
    await expect(stat(path.join(dir, 'a.txt'))).rejects.toThrow();
  });

  it('deny 规则直接拒绝，不进入审批', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'bash', arguments: '{"command":"rm -rf x"}' }]),
      textStep('ok'),
    ]);
    const session = makeSession(provider, [stubBash(executed)], {
      mode: 'default',
      rules: [{ action: 'deny', tool: 'Bash', pattern: 'rm *' }],
    });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    await session.submit({ type: 'user-turn', text: 'go' });

    expect(executed).toEqual([]);
    expect(approvalRequests(events)).toHaveLength(0);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toContain('deny 规则');
  });

  it('中断时挂起的审批被清空，turn 以 interrupted 收尾', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'bash', arguments: '{"command":"sleep 99"}' }]),
    ]);
    const session = makeSession(provider, [stubBash(executed)], { mode: 'default' });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const resultPromise = session.submit({ type: 'user-turn', text: 'go' });
    await vi.waitFor(() => {
      expect(approvalRequests(events)).toHaveLength(1);
    });
    session.interrupt();
    const result = await resultPromise;

    expect(result.stopReason).toBe('interrupted');
    expect(executed).toEqual([]);
    const toolMessage = session.getMessages()[2] as ToolMessage;
    expect(toolMessage.isError).toBe(true);
    expect(toolMessage.content).toBe('interrupted by user');
  });

  it('setPermissionMode 运行时切换：切到 bypass 后 bash 不再审批', async () => {
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'bash', arguments: '{"command":"ls"}' }]),
      textStep('done'),
    ]);
    const session = makeSession(provider, [stubBash(executed)], { mode: 'default' });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    expect(session.getPermissionMode()).toBe('default');
    session.setPermissionMode('bypassPermissions');
    expect(session.getPermissionMode()).toBe('bypassPermissions');
    await session.submit({ type: 'user-turn', text: 'go' });

    expect(executed).toEqual(['ls']);
    expect(approvalRequests(events)).toHaveLength(0);
  });

  it('同一批混着只读与待审批调用：串行判定，结果按原始顺序', async () => {
    const executed: string[] = [];
    const stubRead = defineTool({
      name: 'read',
      description: 'stub read',
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: () => true,
      accesses: () => [{ kind: 'read' }],
      call: (input) => {
        executed.push(`read:${input.path}`);
        return Promise.resolve({ output: `content:${input.path}` });
      },
    });
    const provider = new FakeProvider([
      toolCallStep([
        { name: 'read', arguments: '{"path":"a.txt"}' },
        { name: 'bash', arguments: '{"command":"ls"}' },
      ]),
      textStep('done'),
    ]);
    const session = makeSession(provider, [stubRead, stubBash(executed)], { mode: 'default' });
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
      if (event.type === 'approval-requested') {
        session.submit({ type: 'approval-reply', id: event.request.id, reply: { decision: 'once' } });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    // 只读调用无需审批，审批挂起不阻塞判定流程，两个都执行了
    expect(executed).toContain('read:a.txt');
    expect(executed).toContain('ls');
    expect(approvalRequests(events)).toHaveLength(1);
    const toolMessages = session.getMessages().filter((m) => m.role === 'tool') as ToolMessage[];
    expect(toolMessages.map((m) => m.name)).toEqual(['read', 'bash']);
    expect(toolMessages.map((m) => m.content)).toEqual(['content:a.txt', 'ran:ls']);
  });
});
