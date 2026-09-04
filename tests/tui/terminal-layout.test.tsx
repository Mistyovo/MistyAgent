import { writeFileSync } from 'node:fs';

import { render, type Instance } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Session } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { defineTool } from '#/core/tools/tool';
import type { ToolRegistry } from '#/core/tools/registry';
import type { ChatProvider, StreamedMessagePart } from '#/provider/types';
import { App } from '#/tui/App';
import { setTerminalWidthModeForTests } from '#/tui/terminal-text';

import { FakeProvider, textStep, toolCallStep } from '../core/fake-provider';
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
  // 末尾的空白尾巴不计：动态区从高变矮时，eraseLines 擦掉的旧行在真实终端上
  // 同样以空白行残留在画面底部（等待后续内容滚掉），这是 ink 的正常行为；
  // 要防的是内容之间/之上的残帧空白
  const lines = content.split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') {
    lines.pop();
  }
  let max = 0;
  let current = 0;
  for (const line of lines) {
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

interface TerminalApp {
  stdout: VirtualTerminal;
  stdin: FakeTtyStdin;
  instance: Instance;
}

/**
 * 以真实 eraseLines 路径挂载 App：虚拟终端按 widthMode 模拟物理渲染，
 * 组件侧通过 setTerminalWidthModeForTests 用同一模式预算行宽。
 * wireAskUser=true 时按 main.ts 的方式给 ask_user 接提问能力（sessionRef 闭包）。
 */
function mountTerminalApp(
  provider: ChatProvider,
  widthMode: WidthMode,
  registry?: ToolRegistry,
  wireAskUser = false,
): TerminalApp {
  setTerminalWidthModeForTests(widthMode);
  const stdout = new VirtualTerminal(120, 30, widthMode);
  const stderr = new VirtualTerminal(120, 30, widthMode);
  const stdin = new FakeTtyStdin();
  let sessionRef: Session | null = null;
  const resolvedRegistry =
    registry ??
    createBuiltinRegistry(
      wireAskUser
        ? {
            askUser: (request, signal) =>
              sessionRef?.askUser(request, signal) ?? Promise.resolve({ cancelled: true }),
          }
        : undefined,
    );
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: resolvedRegistry.list(),
    cwd: process.cwd(),
  });
  sessionRef = session;
  // 虚拟终端在运行时满足 ink 的结构性要求（write/columns/rows/isTTY），
  // 类型上与 NodeJS.ReadStream/WriteStream 有差距，此处显式收窄
  const instance = render(
    <App session={session} registry={resolvedRegistry} model="fake-model" cwd={process.cwd()} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  );
  return { stdout, stdin, instance };
}

async function waitForText(stdout: VirtualTerminal, text: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!stdout.content().includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`等待「${text}」超时，当前画面：\n${stdout.content()}`);
    }
    await sleep(50);
  }
}

function dumpOnDemand(content: string, tag: string): void {
  if (process.env.VT_DUMP !== undefined) {
    writeFileSync(`${process.env.VT_DUMP}-${tag}.txt`, content);
  }
}

/** 跑一轮「你好」对话，返回终屏内容 */
async function runTurnInTerminal(widthMode: WidthMode): Promise<string> {
  const { stdout, stdin, instance } = mountTerminalApp(conversationalProvider, widthMode);
  try {
    await sleep(100);
    stdin.write('你好');
    await sleep(100);
    stdin.write('\r');
    await waitForText(stdout, '有什么可以帮你的？');
    await sleep(300); // 等 spinner 停转、最后的静态块落盘
    const content = stdout.content();
    dumpOnDemand(content, widthMode);
    return content;
  } finally {
    instance.unmount();
  }
}

afterEach(() => {
  setTerminalWidthModeForTests(null);
});

describe('真实终端渲染（虚拟终端 + eraseLines 路径）', () => {
  it('narrow 终端（ink 预算语义）：turn 完整落屏且无大片空白', async () => {
    const content = await runTurnInTerminal('narrow');
    expect(content).toContain('▍ 你好');
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

describe('legacy-cjk 回归：上游不可控文本的物理宽度与 sanitize', () => {
  it('长 assistant 文本含 ……/—— 落折行边界：动态区重绘无残帧累积', async () => {
    // 逻辑宽（ink 按 1 格计 …—）= 10 + 25 + 16 + 60 = 111 ≤ 119，
    // 物理宽（legacy 按 2 格）= 10 + 50 + 32 + 60 = 152 → 不修时物理折 2 行、ink 计 1 行
    const ambiguousLine = `首标记HEAD${'…'.repeat(25)}${'——'.repeat(8)}${'汉'.repeat(30)}`;
    const provider: ChatProvider = {
      async *generate(): AsyncGenerator<StreamedMessagePart, void, unknown> {
        yield { type: 'text-delta', text: `${ambiguousLine}\n` };
        // 后续每个 delta 触发一次动态区重绘；坏行在屏期间每次 eraseLines 都可能少擦
        for (let i = 0; i < 6; i += 1) {
          await sleep(120);
          yield { type: 'text-delta', text: `后续第${i}行\n` };
        }
        yield { type: 'text-delta', text: '终局END\n' };
        yield {
          type: 'done',
          usage: { inputTokens: 12, outputTokens: 8 },
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
    };
    const { stdout, stdin, instance } = mountTerminalApp(provider, 'legacy-cjk');
    try {
      await sleep(100);
      stdin.write('go');
      await sleep(100);
      stdin.write('\r');
      await waitForText(stdout, '终局END');
      await sleep(300);
      const content = stdout.content();
      dumpOnDemand(content, 'ambiguous-line');
      expect(occurrences(content, '首标记HEAD')).toBe(1);
      expect(occurrences(content, '终局END')).toBe(1);
      expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
    } finally {
      instance.unmount();
    }
  }, 15_000);

  it('tool 输出含 ANSI 序列与控制字符：剥离后单行上屏，无残帧', async () => {
    const dirty =
      `前缀PRE\x1b[31m红字\x1b[0m\x1b[2J尾部\r覆盖NEXT\x07\x0b` +
      `${'…'.repeat(20)}END标记`;
    const dumpTool = defineTool({
      name: 'dump',
      description: '回显固定脏文本（测试用）',
      inputSchema: z.object({}),
      isReadOnly: () => true,
      describeCall: () => 'Dump 固定脏文本',
      call: async () => ({ output: dirty }),
    });
    const registry = createBuiltinRegistry();
    registry.register(dumpTool);
    const provider = new FakeProvider([
      toolCallStep([{ name: 'dump', arguments: '{}' }]),
      textStep('工具已回显'),
    ]);
    const { stdout, stdin, instance } = mountTerminalApp(provider, 'legacy-cjk', registry);
    try {
      await sleep(100);
      stdin.write('go');
      await sleep(100);
      stdin.write('\r');
      await waitForText(stdout, '工具已回显');
      await sleep(300);
      const content = stdout.content();
      dumpOnDemand(content, 'dirty-tool-output');
      // \r 被剥掉：'尾部' 不被回车覆盖，与 '覆盖NEXT' 同行相邻
      expect(content).toContain('尾部覆盖NEXT');
      // \x0b 被剥掉：不换行，省略号与 END标记 同行
      expect(content).toContain(`${'…'.repeat(20)}END标记`);
      expect(content).toContain('红字');
      expect(occurrences(content, '工具已回显')).toBe(1);
      expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
    } finally {
      instance.unmount();
    }
  }, 15_000);

  it('审批弹窗内超长 bash 命令：弹窗打开期间 spinner 重绘无残帧', async () => {
    // 命令逻辑宽 5 + 100 + 15 = 120，物理宽 5 + 100 + 30 = 135，
    // 弹窗内容预算 115（120 列 - 1 保险 - 4 边框/padding）→ 必须物理折行
    const command = `echo ${'回'.repeat(50)}${'…'.repeat(15)}`;
    const provider = new FakeProvider([
      toolCallStep([{ name: 'bash', arguments: JSON.stringify({ command }) }]),
      textStep('执行完毕'),
    ]);
    const { stdout, stdin, instance } = mountTerminalApp(provider, 'legacy-cjk');
    try {
      await sleep(100);
      stdin.write('run');
      await sleep(100);
      stdin.write('\r');
      await waitForText(stdout, '需要审批');
      // 弹窗打开期间 spinner 以 80ms 帧持续重绘动态区，给残帧累积留足时间
      await sleep(600);
      const dialogContent = stdout.content();
      dumpOnDemand(dialogContent, 'approval-dialog-open');
      expect(occurrences(dialogContent, '需要审批')).toBe(1);
      expect(maxBlankRun(dialogContent)).toBeLessThanOrEqual(2);
      stdin.write('1'); // 放行，bash echo 真实执行
      await waitForText(stdout, '执行完毕');
      await sleep(300);
      const content = stdout.content();
      dumpOnDemand(content, 'approval-dialog-done');
      expect(occurrences(content, '执行完毕')).toBe(1);
      // 弹窗关闭后动态区被干净擦除，不留「需要审批」残影
      expect(occurrences(content, '需要审批')).toBe(0);
      expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
    } finally {
      instance.unmount();
    }
  }, 15_000);

  it('提问弹窗内超长问题（歧义宽字符）：弹窗打开期间 spinner 重绘无残帧', async () => {
    const question = `方案取舍${'…'.repeat(30)}${'——'.repeat(6)}请选择`;
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'ask_user',
          arguments: JSON.stringify({ question, options: [{ label: '甲' }, { label: '乙' }] }),
        },
      ]),
      textStep('已继续'),
    ]);
    const { stdout, stdin, instance } = mountTerminalApp(provider, 'legacy-cjk', undefined, true);
    try {
      await sleep(100);
      stdin.write('ask');
      await sleep(100);
      stdin.write('\r');
      await waitForText(stdout, '提问：');
      // 弹窗打开期间 spinner 以 80ms 帧持续重绘动态区，给残帧累积留足时间
      await sleep(600);
      const dialogContent = stdout.content();
      dumpOnDemand(dialogContent, 'question-dialog-open');
      expect(occurrences(dialogContent, '提问：')).toBe(1);
      expect(maxBlankRun(dialogContent)).toBeLessThanOrEqual(2);
      stdin.write('1'); // 直选「甲」
      await waitForText(stdout, '已继续');
      await sleep(300);
      const content = stdout.content();
      dumpOnDemand(content, 'question-dialog-done');
      expect(occurrences(content, '已继续')).toBe(1);
      // 弹窗关闭后动态区被干净擦除，不留「提问：」残影
      expect(occurrences(content, '提问：')).toBe(0);
      expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
    } finally {
      instance.unmount();
    }
  }, 15_000);
});

describe('长流式输出的增量冲刷', () => {
  it('45 行输出：完整行超 20 行阈值即增量 flush 进 Static 区，拼接完整、每行恰好一次、无残帧', async () => {
    let releaseRest!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    const provider: ChatProvider = {
      async *generate(): AsyncGenerator<StreamedMessagePart, void, unknown> {
        for (let i = 0; i < 30; i += 1) {
          yield { type: 'text-delta', text: `第${i}行内容\n` };
          if (i % 5 === 4) {
            await sleep(60); // 让 50ms 节流分批吐帧，增量 flush 在流式进行中触发
          }
        }
        await gate; // 闸门：前 30 行已超阈值，必然已增量冲刷进 Static 区
        for (let i = 30; i < 45; i += 1) {
          yield { type: 'text-delta', text: `第${i}行内容\n` };
        }
        yield { type: 'text-delta', text: '末尾TAIL' };
        yield {
          type: 'done',
          usage: { inputTokens: 12, outputTokens: 8 },
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
    };
    const { stdout, stdin, instance } = mountTerminalApp(provider, 'narrow');
    try {
      await sleep(100);
      stdin.write('go');
      await sleep(100);
      stdin.write('\r');
      await waitForText(stdout, '第29行内容');
      await sleep(200); // 等节流帧与增量 flush 落盘
      const mid = stdout.content();
      // 中途态：前段已上屏且唯一，后段还在 provider 闸门后
      expect(occurrences(mid, '第0行内容')).toBe(1);
      expect(mid).not.toContain('第30行内容');
      expect(maxBlankRun(mid)).toBeLessThanOrEqual(2);
      releaseRest();
      await waitForText(stdout, '末尾TAIL');
      await sleep(300);
      const content = stdout.content();
      dumpOnDemand(content, 'incremental-flush');
      // Static 区增量块与动态区尾部拼接正确：首/中/尾各恰好一次，顺序不变
      expect(occurrences(content, '第0行内容')).toBe(1);
      expect(occurrences(content, '第22行内容')).toBe(1);
      expect(occurrences(content, '第44行内容')).toBe(1);
      expect(occurrences(content, '末尾TAIL')).toBe(1);
      expect(content.indexOf('第0行内容')).toBeLessThan(content.indexOf('第22行内容'));
      expect(content.indexOf('第22行内容')).toBeLessThan(content.indexOf('第44行内容'));
      expect(content.indexOf('第44行内容')).toBeLessThan(content.indexOf('末尾TAIL'));
      expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
    } finally {
      instance.unmount();
    }
  }, 15_000);
});
