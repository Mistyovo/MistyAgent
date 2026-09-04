import { writeFileSync } from 'node:fs';

import { render, type Instance } from 'ink';
import { describe, expect, it } from 'vitest';

import { Session } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import type { ChatProvider, StreamedMessagePart } from '#/provider/types';
import { App } from '#/tui/App';

import { FakeTtyStdin, VirtualTerminal, type WidthMode } from './virtual-terminal';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 含 reasoning/text delta 的真实感 turn；中途停顿让 spinner 帧持续重绘动态区 */
const conversationalProvider: ChatProvider = {
  async *generate(): AsyncGenerator<StreamedMessagePart, void, unknown> {
    yield { type: 'reasoning-delta', text: '用户在打招呼，\n' };
    await sleep(200);
    yield { type: 'reasoning-delta', text: '简短回应即可。\n' };
    yield { type: 'text-delta', text: '你好！我是 Misty。\n' };
    await sleep(200);
    yield { type: 'text-delta', text: '有什么可以帮你的？' };
    yield {
      type: 'done',
      usage: { inputTokens: 12, outputTokens: 8 },
      finishReason: 'completed',
      rawFinishReason: 'stop',
    };
  },
};

function maxBlankRun(content: string): number {
  let max = 0;
  let current = 0;
  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function occurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

async function runTurnInTerminal(widthMode: WidthMode): Promise<string> {
  const stdout = new VirtualTerminal(120, 30, widthMode);
  const stderr = new VirtualTerminal(120, 30, widthMode);
  const stdin = new FakeTtyStdin();
  const registry = createBuiltinRegistry();
  const session = new Session({
    provider: conversationalProvider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: registry.list(),
    cwd: process.cwd(),
  });
  let instance: Instance | undefined;
  try {
    instance = render(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
      // 虚拟终端在运行时满足 ink 的结构性要求（write/columns/rows/isTTY），
      // 类型上与 NodeJS.ReadStream/WriteStream 有差距，此处显式收窄
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
      },
    );
    await sleep(100);
    stdin.write('你好');
    await sleep(100);
    stdin.write('\r');
    const deadline = Date.now() + 5000;
    while (!stdout.content().includes('有什么可以帮你的？')) {
      if (Date.now() > deadline) {
        throw new Error(`等待 turn 完成超时，当前画面：\n${stdout.content()}`);
      }
      await sleep(50);
    }
    await sleep(300); // 等 spinner 停转、最后的静态块落盘
    const content = stdout.content();
    if (process.env.VT_DUMP !== undefined) {
      writeFileSync(`${process.env.VT_DUMP}-${widthMode}.txt`, content);
    }
    return content;
  } finally {
    instance?.unmount();
  }
}

describe('真实终端渲染（虚拟终端 + eraseLines 路径）', () => {
  it('narrow 终端（ink 预算语义）：turn 完整落屏且无大片空白', async () => {
    const content = await runTurnInTerminal('narrow');
    expect(content).toContain('> 你好');
    expect(content).toContain('用户在打招呼');
    expect(content).toContain('你好！我是 Misty。');
    expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
  }, 15_000);

  it('legacy-cjk 终端（中文 cmd.exe：歧义宽字符 2 格）：无连续 3 行以上空白', async () => {
    const content = await runTurnInTerminal('legacy-cjk');
    expect(content).toContain('> 你好');
    expect(content).toContain('用户在打招呼');
    expect(content).toContain('你好！我是 Misty。');
    // 回归断言：修复前此处因 ─ 边框行物理换行与 ink 行高预算不符，
    // 每次动态区重绘都残留一行空白，spinner 期间累积成大片空白
    expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
    // 同一根因的另一表现：eraseLines 少擦导致已上屏内容重复出现
    expect(occurrences(content, '> 你好')).toBe(1);
    expect(occurrences(content, '用户在打招呼，')).toBe(1);
    expect(occurrences(content, 'MistyAgent  fake-model')).toBe(1);
  }, 15_000);
});
