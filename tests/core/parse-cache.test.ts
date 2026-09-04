import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { PermissionMode, PermissionRule } from '#/config/schema';
import type { AgentEvent, ApprovalRequestedEvent } from '#/core/events';
import { matchRule } from '#/core/permission/rules';
import { Session } from '#/core/session/session';
import { defineTool, type Tool, type ToolContext } from '#/core/tools/tool';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const picomatchCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('picomatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('picomatch')>();
  const base = (actual as unknown as { default: typeof actual }).default;
  const wrapped = ((...args: Parameters<typeof base>) => {
    picomatchCalls.count += 1;
    return base(...args);
  }) as typeof base;
  return { default: wrapped };
});

const cwd = process.cwd();
const ctx: ToolContext = { cwd, signal: new AbortController().signal };

/** 每次 parse 都计数的 schema（preprocess 在每次解析尝试时都会执行） */
function countingSchema(parseCount: { n: number }) {
  return z.preprocess((value) => {
    parseCount.n += 1;
    return value;
  }, z.object({ command: z.string() }));
}

function countingProbe(parseCount: { n: number }, executed: string[]): Tool {
  return defineTool({
    name: 'probe',
    description: '带 parse 计数的探针工具',
    inputSchema: countingSchema(parseCount),
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) => `Probe ${input.command}`,
    call: (input) => {
      executed.push(input.command);
      return Promise.resolve({ output: `ran:${input.command}` });
    },
  });
}

describe('defineTool parse 缓存', () => {
  it('同一 input 对象在 isReadOnly/accesses/describeCall/call 间只 parse 一次', async () => {
    const parseCount = { n: 0 };
    const executed: string[] = [];
    const tool = countingProbe(parseCount, executed);
    const input = { command: 'ls' };

    expect(tool.isReadOnly(input)).toBe(false);
    expect(tool.accesses(input)).toEqual([{ kind: 'execute' }]);
    expect(tool.describeCall(input)).toBe('Probe ls');
    await expect(tool.call(input, ctx)).resolves.toEqual({ output: 'ran:ls' });

    expect(parseCount.n).toBe(1);
    expect(executed).toEqual(['ls']);
  });

  it('换对象引用会重新 parse（缓存键是对象引用）', () => {
    const parseCount = { n: 0 };
    const tool = countingProbe(parseCount, []);

    expect(tool.accesses({ command: 'ls' })).toEqual([{ kind: 'execute' }]);
    expect(tool.accesses({ command: 'ls' })).toEqual([{ kind: 'execute' }]);
    expect(parseCount.n).toBe(2);
  });

  it('非法 input 同样只 parse 一次，各入口维持兜底行为', () => {
    const parseCount = { n: 0 };
    const tool = countingProbe(parseCount, []);
    const bad = { nope: 1 };

    expect(tool.isReadOnly(bad)).toBe(false);
    expect(tool.accesses(bad)).toEqual([{ kind: 'execute' }]);
    expect(tool.describeCall(bad)).toBe('probe');
    // 与原先 inputSchema.parse 一致：同步抛 ZodError
    expect(() => tool.call(bad, ctx)).toThrow(z.ZodError);
    expect(parseCount.n).toBe(1);
  });

  it('原始值 input 不进缓存，行为不变', () => {
    const parseCount = { n: 0 };
    const tool = countingProbe(parseCount, []);

    expect(tool.isReadOnly('nope')).toBe(false);
    expect(tool.accesses(42)).toEqual([{ kind: 'execute' }]);
    expect(parseCount.n).toBe(2);
  });

  it('各入口拿到的都是 parse 产物（含 default 补全），不是原始 input', async () => {
    const seen: unknown[] = [];
    const tool = defineTool({
      name: 'defaults',
      description: '校验 parse 产物下传',
      inputSchema: z.object({ command: z.string(), retries: z.number().default(3) }),
      describeCall: (input) => `retries=${input.retries}`,
      call: (input) => {
        seen.push(input);
        return Promise.resolve({ output: `retries:${input.retries}` });
      },
    });
    const input = { command: 'ls' };

    expect(tool.describeCall(input)).toBe('retries=3');
    await expect(tool.call(input, ctx)).resolves.toEqual({ output: 'retries:3' });
    expect(seen[0]).toEqual({ command: 'ls', retries: 3 });
  });
});

describe('调度链路端到端 parse 次数', () => {
  function makeSession(
    provider: FakeProvider,
    tools: Tool[],
    permission: { mode?: PermissionMode; rules?: PermissionRule[] },
  ): Session {
    return new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools,
      cwd,
      permission,
    });
  }

  it('bypassPermissions：一次调用全程只 parse 一次', async () => {
    const parseCount = { n: 0 };
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'probe', arguments: '{"command":"ls"}' }]),
      textStep('done'),
    ]);
    const session = makeSession(provider, [countingProbe(parseCount, executed)], {
      mode: 'bypassPermissions',
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(executed).toEqual(['ls']);
    expect(parseCount.n).toBe(1);
  });

  it('default 模式审批链路（含 describeCall）也只 parse 一次', async () => {
    const parseCount = { n: 0 };
    const executed: string[] = [];
    const provider = new FakeProvider([
      toolCallStep([{ name: 'probe', arguments: '{"command":"git status"}' }]),
      textStep('done'),
    ]);
    const session = makeSession(provider, [countingProbe(parseCount, executed)], { mode: 'default' });
    const events: AgentEvent[] = [];
    session.onEvent((event) => {
      events.push(event);
      if (event.type === 'approval-requested') {
        session.submit({ type: 'approval-reply', id: event.request.id, reply: { decision: 'once' } });
      }
    });

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    expect(executed).toEqual(['git status']);
    const requests = events.filter((e): e is ApprovalRequestedEvent => e.type === 'approval-requested');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.describeCall).toBe('Probe git status');
    expect(parseCount.n).toBe(1);
  });
});

describe('compileGlob 编译缓存', () => {
  it('同一 bash pattern 重复匹配只编译一次，结果一致', () => {
    const rule: PermissionRule = { action: 'allow', tool: 'Bash', pattern: 'git *' };
    const before = picomatchCalls.count;

    expect(matchRule(rule, 'bash', { command: 'git status' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'git push origin main' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'git' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'rm -rf x' }, cwd)).toBe(false);

    expect(picomatchCalls.count - before).toBe(1);
  });

  it('同一 pattern 字符串按 nocase 维度分别缓存', () => {
    const before = picomatchCalls.count;

    // tool 字段 glob 走 nocase: true
    expect(matchRule({ action: 'allow', tool: 'mcp__probe__*' }, 'mcp__probe__read', {}, cwd)).toBe(true);
    expect(matchRule({ action: 'allow', tool: 'mcp__probe__*' }, 'MCP__PROBE__WRITE', {}, cwd)).toBe(true);
    // bash pattern 走 nocase: false，同字符串是另一个缓存键
    const rule: PermissionRule = { action: 'allow', tool: 'Bash', pattern: 'mcp__probe__*' };
    expect(matchRule(rule, 'bash', { command: 'mcp__probe__x' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'MCP__PROBE__X' }, cwd)).toBe(false);

    expect(picomatchCalls.count - before).toBe(2);
  });

  it('路径 pattern 重复匹配只编译一次，结果一致', () => {
    const rule: PermissionRule = { action: 'deny', tool: 'Write', pattern: 'src/**' };
    const before = picomatchCalls.count;

    expect(matchRule(rule, 'write', { path: 'src/a.ts' }, cwd)).toBe(true);
    expect(matchRule(rule, 'write', { path: 'src/deep/b.ts' }, cwd)).toBe(true);
    expect(matchRule(rule, 'write', { path: 'tests/c.ts' }, cwd)).toBe(false);

    expect(picomatchCalls.count - before).toBe(1);
  });
});
