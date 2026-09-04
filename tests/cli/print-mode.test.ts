import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runPrintMode } from '#/cli/print-mode';
import { Session } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { ToolRegistry } from '#/core/tools/registry';
import { defineTool } from '#/core/tools/tool';
import type { StreamedMessagePart } from '#/provider/types';

import { FakeProvider, textStep, toolCallStep } from '../core/fake-provider';

function fakeStream(): { stream: Writable; text: () => string } {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });
  return { stream, text: () => data };
}

async function run(scripts: StreamedMessagePart[][]) {
  const provider = new FakeProvider(scripts);
  const registry = createBuiltinRegistry();
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: registry.list(),
    cwd: process.cwd(),
  });
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await runPrintMode({
    session,
    registry,
    prompt: 'go',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

describe('runPrintMode', () => {
  it('completed：文本流式进 stdout（补尾换行），stderr 干净，退出码 0', async () => {
    const { code, stdout, stderr } = await run([textStep('你好，世界')]);
    expect(code).toBe(0);
    expect(stdout).toBe('你好，世界\n');
    expect(stderr).toBe('');
  });

  it('工具被拒执行：审批请求自动拒绝并回喂，完成摘要进 stderr（无 ⏵ 启动行）', async () => {
    const { code, stdout, stderr } = await run([
      toolCallStep([{ name: 'bash', arguments: '{"command":"echo hi"}' }]),
      textStep('收尾'),
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe('收尾\n');
    expect(stderr).not.toContain('⏵');
    expect(stderr).toContain('无头模式无法交互审批，已自动拒绝：Bash echo hi');
    expect(stderr).toMatch(/✗ Bash echo hi（\d+ms）/);
  });

  it('只读工具放行执行：stderr 依次出现 ⏵ 启动行与 ✓ 完成行', async () => {
    const fakeRead = defineTool({
      name: 'fake_read',
      description: 'test',
      inputSchema: z.object({}),
      isReadOnly: () => true,
      describeCall: () => 'FakeRead',
      call: async () => ({ output: 'fake-output' }),
    });
    const provider = new FakeProvider([
      toolCallStep([{ name: 'fake_read', arguments: '{}' }]),
      textStep('收尾'),
    ]);
    const registry = new ToolRegistry();
    registry.register(fakeRead);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
    });
    const stdout = fakeStream();
    const stderr = fakeStream();
    const code = await runPrintMode({
      session,
      registry,
      prompt: 'go',
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toBe('收尾\n');
    expect(stderr.text()).toMatch(/⏵ FakeRead\n✓ FakeRead（\d+ms）\n/);
  });

  it('无头模式提问：ask_user 直接回喂自行决策，不挂起不弹审批', async () => {
    const { code, stdout, stderr } = await run([
      toolCallStep([
        {
          name: 'ask_user',
          arguments: '{"question":"选哪个方案？","options":[{"label":"甲"},{"label":"乙"}]}',
        },
      ]),
      textStep('自行决策收尾'),
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe('自行决策收尾\n');
    // 交互型工具权限直接放行：不出现审批拒绝行；工具完成行带 ✗（无头回喂是 isError）
    expect(stderr).not.toContain('无头模式无法交互审批');
    expect(stderr).toMatch(/✗ Ask: 选哪个方案？（\d+ms）/);
  });

  it('error：错误写 stderr，退出码 1', async () => {
    const { code, stderr } = await run([[{ type: 'error', error: new Error('boom') }]]);
    expect(code).toBe(1);
    expect(stderr).toContain('✗ boom');
  });
});
