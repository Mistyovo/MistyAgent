import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentEvent } from '#/core/events';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { StallGuard, type StallCall } from '#/core/loop/stall-guard';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { defineTool, type Tool } from '#/core/tools/tool';
import type { UserMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

const readCall: StallCall = { name: 'read', input: { path: 'a.ts' }, isReadOnly: true };
const writeCall: StallCall = { name: 'write', input: { path: 'a.ts' }, isReadOnly: false };

describe('StallGuard', () => {
  it('连续 4 步 barren 触发一次 steer，之后不再发', () => {
    const guard = new StallGuard();
    expect(guard.recordStep([readCall], ['内容A'])).toBeNull(); // 新输出，不计入
    expect(guard.recordStep([readCall], ['内容A'])).toBeNull(); // barren 1
    expect(guard.recordStep([readCall], ['内容A'])).toBeNull(); // 2
    expect(guard.recordStep([readCall], ['内容A'])).toBeNull(); // 3
    const steer = guard.recordStep([readCall], ['内容A']); // 4 → steer
    expect(steer).toContain('produced no new information');
    expect(steer).toContain('re-read content already seen');
    expect(guard.recordStep([readCall], ['内容A'])).toBeNull(); // 每 turn 最多一次
  });

  it('任何新输出都会清零连续计数', () => {
    const guard = new StallGuard();
    guard.recordStep([readCall], ['A']); // 新
    guard.recordStep([readCall], ['A']); // 1
    guard.recordStep([readCall], ['A']); // 2
    guard.recordStep([readCall], ['B']); // 新输出 → 清零
    expect(guard.recordStep([readCall], ['A'])).toBeNull(); // 1
    expect(guard.recordStep([readCall], ['B'])).toBeNull(); // 2
    expect(guard.recordStep([readCall], ['A'])).toBeNull(); // 3
    expect(guard.recordStep([readCall], ['B'])).not.toBeNull(); // 4 → steer
  });

  it('含非只读调用的步清零连续计数', () => {
    const guard = new StallGuard();
    guard.recordStep([readCall], ['A']); // 新
    guard.recordStep([readCall], ['A']); // 1
    guard.recordStep([readCall], ['A']); // 2
    guard.recordStep([readCall], ['A']); // 3
    guard.recordStep([writeCall], ['written']); // 非只读 → 清零
    expect(guard.recordStep([readCall], ['A'])).toBeNull(); // 1
    expect(guard.recordStep([readCall], ['A'])).toBeNull(); // 2
    expect(guard.recordStep([readCall], ['A'])).toBeNull(); // 3
    expect(guard.recordStep([readCall], ['A'])).not.toBeNull(); // 4 → steer
  });

  it('同一步混合只读与写调用不算 barren，但输出仍入集合', () => {
    const guard = new StallGuard();
    const mixed: StallCall[] = [readCall, writeCall];
    for (let index = 0; index < 6; index += 1) {
      expect(guard.recordStep(mixed, ['A', 'w'])).toBeNull();
    }
    // 输出已被记录：只读重复 4 次即触发
    guard.recordStep([readCall], ['A']); // 1
    guard.recordStep([readCall], ['A']); // 2
    guard.recordStep([readCall], ['A']); // 3
    expect(guard.recordStep([readCall], ['A'])).not.toBeNull();
  });

  it('空调用或空输出的步不计入也不崩溃', () => {
    const guard = new StallGuard();
    for (let index = 0; index < 10; index += 1) {
      expect(guard.recordStep([], [])).toBeNull();
      expect(guard.recordStep([readCall], [])).toBeNull();
    }
  });

  it('同一步多个只读调用需全部输出已见才算 barren', () => {
    const guard = new StallGuard();
    guard.recordStep([readCall, readCall], ['A', 'B']); // 都新
    guard.recordStep([readCall, readCall], ['A', 'B']); // 1
    guard.recordStep([readCall, readCall], ['A', 'C']); // 含新输出 → 清零
    expect(guard.recordStep([readCall, readCall], ['A', 'C'])).toBeNull(); // 1
  });
});

const constantReadTool = defineTool({
  name: 'read',
  description: '读取（输出恒定）',
  inputSchema: z.object({ path: z.string() }),
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  call: () => Promise.resolve({ output: '内容恒定' }),
});

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

function steers(deps: RunTurnDeps): UserMessage[] {
  return deps.messages.filter(
    (m): m is UserMessage => m.role === 'user' && m.content.includes('produced no new information'),
  );
}

describe('零产出停滞检测（runTurn 集成）', () => {
  it('连续重复读取已见内容触发一次 steer 后 turn 继续', async () => {
    // 参数各不相同的读取：绕开 doom-loop（签名不同），靠输出内容判停滞
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"a"}', id: 'c1' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"b"}', id: 'c2' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"c"}', id: 'c3' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"d"}', id: 'c4' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"e"}', id: 'c5' }]),
      textStep('基于已有信息给结论'),
    ]);
    const deps = makeDeps(provider, [constantReadTool], []);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBe(6);
    expect(steers(deps)).toHaveLength(1);
    expect(deps.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    // steer 进入最后一步请求的历史
    const lastRequest = provider.requests[5]!;
    expect(lastRequest.messages.at(-1)?.role).toBe('user');
    expect((lastRequest.messages.at(-1) as UserMessage).content).toContain('produced no new information');
  });

  it('doom-loop 介入的步不计入 barren，不再叠加 steer', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"a"}', id: 'c1' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"a"}', id: 'c2' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"a"}', id: 'c3' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"a"}', id: 'c4' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"a"}', id: 'c5' }]),
      textStep('换思路'),
    ]);
    const events: AgentEvent[] = [];
    const permission = createPermissionRuntime({ mode: 'bypassPermissions', cwd });
    const deps = makeDeps(provider, [constantReadTool], events, {
      permission,
      dispatchEvent: (event) => {
        events.push(event);
        if (event.type === 'approval-requested') {
          permission.approvals.reply(event.request.id, { decision: 'reject' });
        }
      },
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    // 第 1 步输出为新（不计入），第 2 步 barren 1，第 3-5 步 doom-loop 审批介入被跳过
    expect(steers(deps)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'approval-requested')).toHaveLength(3);
  });

  it('只读但输出持续有新内容时不发 steer', async () => {
    const freshReadTool = defineTool({
      name: 'read',
      description: '读取（输出递增）',
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: () => true,
      accesses: () => [{ kind: 'read' }],
      call: (input) => Promise.resolve({ output: `内容:${input.path}` }),
    });
    const provider = new FakeProvider([
      toolCallStep([{ name: 'read', arguments: '{"path":"a"}', id: 'c1' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"b"}', id: 'c2' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"c"}', id: 'c3' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"d"}', id: 'c4' }]),
      toolCallStep([{ name: 'read', arguments: '{"path":"e"}', id: 'c5' }]),
      textStep('读完'),
    ]);
    const deps = makeDeps(provider, [freshReadTool], []);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(steers(deps)).toHaveLength(0);
  });
});
