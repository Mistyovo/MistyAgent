import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentEvent } from '#/core/events';
import { evaluateCompletionGate } from '#/core/loop/completion-gate';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { defineTool, type Tool } from '#/core/tools/tool';
import type { AssistantMessage, Message, ToolCall, ToolMessage, UserMessage } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

function assistantWithCalls(calls: ToolCall[]): AssistantMessage {
  return { role: 'assistant', content: '', toolCalls: calls };
}

function bashCall(id: string, command: string): ToolCall {
  return { id, name: 'bash', arguments: JSON.stringify({ command }) };
}

function toolResult(id: string, content: string, isError?: boolean): ToolMessage {
  const message: ToolMessage = { role: 'tool', toolCallId: id, name: 'bash', content };
  if (isError !== undefined) {
    message.isError = isError;
  }
  return message;
}

describe('evaluateCompletionGate', () => {
  it('纯问答 turn（无工具调用）声明完成也放行', () => {
    const verdict = evaluateCompletionGate({
      turnMessages: [{ role: 'user', content: '解释一下' }],
      finalText: '已完成',
    });
    expect(verdict.pass).toBe(true);
  });

  it('只读调用不构成变更，声明完成放行', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]),
      toolResult('c1', 'file content'),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: '问题已解决' });
    expect(verdict.pass).toBe(true);
  });

  it('write 变更 + 声明完成 + 无任何验证 → 拦截并给出提醒', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      toolResult('c1', 'written'),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: '已修复' });
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) {
      expect(verdict.reminder).toContain('verification command');
      expect(verdict.reminder).toContain('unverified');
    }
  });

  it('edit 变更 + npm test 成功 → 放行', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'edit', arguments: '{"path":"a.ts"}' }]),
      toolResult('c1', 'edited'),
      assistantWithCalls([bashCall('c2', 'npm test')]),
      toolResult('c2', 'ok 12 passed'),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: '测试通过' });
    expect(verdict.pass).toBe(true);
  });

  it('验证命令执行失败（isError）不算证据', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      toolResult('c1', 'written'),
      assistantWithCalls([bashCall('c2', 'npm test')]),
      toolResult('c2', '命令失败（exit code 1）', true),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: '全部通过' });
    expect(verdict.pass).toBe(false);
  });

  it('验证命令的 tool 消息缺失时不算证据', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      toolResult('c1', 'written'),
      assistantWithCalls([bashCall('c2', 'npm test')]),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: '已完成' });
    expect(verdict.pass).toBe(false);
  });

  it('bash 跑了非验证命令（ls）不构成证据', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([bashCall('c1', 'ls -la')]),
      toolResult('c1', 'a.ts'),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: '已搞定' });
    expect(verdict.pass).toBe(false);
  });

  it.each([
    'pnpm run test',
    'yarn build',
    'bun run lint',
    'npm run typecheck',
    'npx vitest run',
    'cargo test',
    'go test ./...',
    'npx tsc --noEmit',
    'make',
    'mvn test',
    'gradle build',
    'npx oxlint',
  ])('验证命令覆盖：%s 成功即放行', (command) => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      toolResult('c1', 'written'),
      assistantWithCalls([bashCall('c2', command)]),
      toolResult('c2', 'ok', false),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: 'all tests passed' });
    expect(verdict.pass).toBe(true);
  });

  it('bash 构建命令同时算变更与证据', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([bashCall('c1', 'npm run build')]),
      toolResult('c1', 'build ok'),
    ];
    const verdict = evaluateCompletionGate({ turnMessages, finalText: '构建成功' });
    expect(verdict.pass).toBe(true);
  });

  it('英文完成声明也纳入判定（fixed / done）', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      toolResult('c1', 'written'),
    ];
    expect(evaluateCompletionGate({ turnMessages, finalText: 'Bug fixed.' }).pass).toBe(false);
    expect(evaluateCompletionGate({ turnMessages, finalText: 'All done!' }).pass).toBe(false);
  });

  it('误伤检查：叙述性文本不视为完成声明', () => {
    const turnMessages: Message[] = [
      assistantWithCalls([{ id: 'c1', name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      toolResult('c1', 'written'),
    ];
    expect(evaluateCompletionGate({ turnMessages, finalText: '接下来需要运行测试验证' }).pass).toBe(
      true,
    );
    expect(evaluateCompletionGate({ turnMessages, finalText: '问题尚未修复' }).pass).toBe(true);
    expect(evaluateCompletionGate({ turnMessages, finalText: '修改了配置文件' }).pass).toBe(true);
    // 裸 done 不带限定词时不算完成声明（探索类收尾的常见措辞）
    expect(evaluateCompletionGate({ turnMessages, finalText: 'done' }).pass).toBe(true);
    expect(evaluateCompletionGate({ turnMessages, finalText: '看完了，done' }).pass).toBe(true);
  });
});

const writeTool = defineTool({
  name: 'write',
  description: '写文件',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  accesses: () => [{ kind: 'write' }],
  call: () => Promise.resolve({ output: 'written' }),
});

const bashTool = defineTool({
  name: 'bash',
  description: '执行命令',
  inputSchema: z.object({ command: z.string() }),
  accesses: () => [{ kind: 'execute' }],
  call: (input) => Promise.resolve({ output: `ran:${input.command}` }),
});

function makeDeps(
  provider: FakeProvider,
  tools: Tool[],
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
    dispatchEvent: () => {},
    permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd }),
    ...overrides,
  };
}

function reminders(deps: RunTurnDeps): UserMessage[] {
  return deps.messages.filter(
    (m): m is UserMessage => m.role === 'user' && m.content.includes('verification command'),
  );
}

describe('完成举证闸门（runTurn 集成）', () => {
  it('write 后无验证直接宣布完成 → 提醒一次后 turn 继续，再次收官直接放行', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      textStep('已修复，测试通过'),
      textStep('补充说明：已修复'),
    ]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [writeTool, bashTool], {
      dispatchEvent: (event) => events.push(event),
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBe(3);
    expect(deps.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
    // 第二次收官仍是完成声明但预算已用尽：提醒只发一次
    expect(reminders(deps)).toHaveLength(1);
    // 提醒进入下一步请求的历史
    const nextRequest = provider.requests[2]!;
    expect(nextRequest.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    const reminder = nextRequest.messages[4] as UserMessage;
    expect(reminder.content).toContain('verification command');
  });

  it('有成功验证命令时直接收官，不发提醒', async () => {
    const provider = new FakeProvider([
      toolCallStep([{ name: 'write', arguments: '{"path":"a.ts","content":"x"}' }]),
      toolCallStep([{ name: 'bash', arguments: '{"command":"npm test"}' }]),
      textStep('全部通过'),
    ]);
    const deps = makeDeps(provider, [writeTool, bashTool]);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBe(3);
    expect(reminders(deps)).toHaveLength(0);
    expect(provider.requests).toHaveLength(3);
  });

  it('纯问答 turn 声明完成不触发提醒', async () => {
    const provider = new FakeProvider([textStep('已解答完毕，done')]);
    const deps = makeDeps(provider, [writeTool, bashTool]);

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBe(1);
    expect(reminders(deps)).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });
});
