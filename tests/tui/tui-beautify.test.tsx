import chalk, { type ColorSupportLevel } from 'chalk';
import { render, renderToString } from 'ink';
import { render as renderTestingLibrary } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Session } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { App } from '#/tui/App';
import { PlanApprovalDialog } from '#/tui/components/PlanApprovalDialog';
import { PromptInput } from '#/tui/components/PromptInput';
import { QuestionDialog } from '#/tui/components/QuestionDialog';
import { StatusBar } from '#/tui/components/StatusBar';
import { TodoList } from '#/tui/components/TodoList';
import {
  measureTerminalWidth,
  sanitizeTerminalText,
  setTerminalWidthModeForTests,
} from '#/tui/terminal-text';
import { setThemeForTests, themePalettes } from '#/tui/theme';

import { FakeProvider, textStep } from '../core/fake-provider';
import { FakeTtyStdin, VirtualTerminal } from './virtual-terminal';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 剥掉 ANSI 后按物理宽度断言用 */
const visibleLines = (output: string): string[] =>
  output.split('\n').filter((line) => line.trim() !== '');

/** chalk 对 hex 前景/背景色生成的真彩 SGR 序列前缀 */
function hexToSgr(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function hexToBgSgr(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[48;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** 以指定 chalk 色彩等级执行 run（vitest 无 TTY，默认 level 0 不发 SGR），结束后还原 */
const withChalkLevel = (level: ColorSupportLevel, run: () => void): void => {
  const previous = chalk.level;
  chalk.level = level;
  try {
    run();
  } finally {
    chalk.level = previous;
  }
};

function occurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function maxBlankRun(content: string): number {
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

async function waitForText(stdout: VirtualTerminal, text: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!stdout.content().includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`等待「${text}」超时，当前画面：\n${stdout.content()}`);
    }
    await sleep(50);
  }
}

afterEach(() => {
  setThemeForTests(null);
  setTerminalWidthModeForTests(null);
});

describe('StatusBar 反色底栏', () => {
  const fullProps = (
    <StatusBar
      cwd="xwork"
      model="fake-model"
      mode="default"
      usage={{ inputTokens: 1200, outputTokens: 300 }}
      busy={true}
      runningTasks={2}
      exitArmed={false}
    />
  );

  it('单行落屏：narrow 与 legacy-cjk 两种宽度模式下物理宽度都不超 列数-1', () => {
    // renderToString 无 TTY，列数回退 80 → 预算 79
    expect(
      measureTerminalWidth(visibleLines(renderToString(fullProps))[0]!, 'narrow'),
    ).toBeLessThanOrEqual(79);

    setTerminalWidthModeForTests('legacy-cjk');
    const lines = visibleLines(renderToString(fullProps));
    // 不折行：整栏仍是一行（chalk level 0 时尾部底色填充被 ink trimEnd，属预期）
    expect(lines).toHaveLength(1);
    expect(measureTerminalWidth(lines[0]!, 'legacy-cjk')).toBeLessThanOrEqual(79);
  });

  it('左簇 basename/模型/模式，右簇 busy/后台任务/token 用量，顺序固定', () => {
    const line = visibleLines(renderToString(fullProps))[0]!;
    const order = ['xwork', 'fake-model', '? default', '…', '⚙ 2', '↑1.2k', '↓300'];
    for (let index = 1; index < order.length; index += 1) {
      expect(line.indexOf(order[index]!)).toBeGreaterThan(line.indexOf(order[index - 1]!));
    }
  });

  it('rich 主题：整行发 statusBarBg 背景 SGR，模式保留模式色，填满 列数-1 宽', () => {
    setThemeForTests(themePalettes.dark.rich);
    withChalkLevel(3, () => {
      const output = renderToString(fullProps);
      expect(output).toContain(hexToBgSgr(themePalettes.dark.rich.statusBarBg));
      expect(output).toContain(hexToSgr(themePalettes.dark.rich.permissionMode.default));
      // 带色输出时尾部背景填充不被 trimEnd（行尾是 SGR 复位），整行恰好填满 79 格
      const line = sanitizeTerminalText(visibleLines(output)[0]!);
      expect(measureTerminalWidth(line, 'narrow')).toBe(79);
    });
  });

  it('basic 主题：背景发黑底命名色 SGR，无真彩序列', () => {
    setThemeForTests(themePalettes.dark.basic);
    withChalkLevel(1, () => {
      const output = renderToString(fullProps);
      expect(output).toContain('\x1b[40m');
      expect(output).not.toContain('48;2;');
    });
  });

  it('超窄终端（40 列 legacy-cjk）+ 超长 basename：截断进预算，单行不折行', async () => {
    setTerminalWidthModeForTests('legacy-cjk');
    const stdout = new VirtualTerminal(40, 10, 'legacy-cjk');
    const stderr = new VirtualTerminal(40, 10, 'legacy-cjk');
    const stdin = new FakeTtyStdin();
    const instance = render(
      <StatusBar
        cwd={`/tmp/${'a'.repeat(60)}`}
        model="m"
        mode="default"
        usage={null}
        busy={false}
        runningTasks={0}
        exitArmed={false}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
      },
    );
    try {
      await sleep(100);
      const lines = stdout
        .content()
        .split('\n')
        .filter((line) => line.trim() !== '');
      expect(lines).toHaveLength(1);
      expect(measureTerminalWidth(lines[0]!, 'legacy-cjk')).toBeLessThanOrEqual(39);
      expect(lines[0]).toContain('…');
      expect(lines[0]).toContain('? default');
    } finally {
      instance.unmount();
    }
  });
});

describe('TodoList 面板化', () => {
  const todos = (
    <TodoList
      todos={[
        { content: '实现功能', status: 'in_progress', activeForm: '正在实现功能' },
        { content: '写测试', status: 'pending' },
        { content: '读代码', status: 'done' },
      ]}
    />
  );

  it('dim 标题行「任务」在前，列表项缩进 2 格', () => {
    const lines = visibleLines(renderToString(todos));
    expect(lines[0]).toBe('任务');
    expect(lines[1]).toBe('  ▶ 正在实现功能');
    expect(lines[2]).toBe('  ☐ 写测试');
    expect(lines[3]).toBe('  ☑ 读代码');
  });

  it('标题发 dim SGR；in_progress 项用 accent 色', () => {
    withChalkLevel(1, () => {
      expect(renderToString(todos)).toContain('\x1b[2m任务');
    });
    setThemeForTests(themePalettes.dark.rich);
    withChalkLevel(3, () => {
      const output = renderToString(todos);
      expect(output).toContain(hexToSgr(themePalettes.dark.rich.accent));
    });
  });
});

describe('弹窗美化', () => {
  it('QuestionDialog：统一 · 分隔的键位提示行（单选/多选）', () => {
    const base = { id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] };
    expect(renderToString(<QuestionDialog request={base} onReply={() => {}} />)).toContain(
      '↑↓ 移动 · 1-4 直选 · Enter 确认 · Esc 跳过',
    );
    expect(
      renderToString(<QuestionDialog request={{ ...base, multiSelect: true }} onReply={() => {}} />),
    ).toContain('↑↓ 移动 · 空格/1-4 勾选 · Enter 确认 · Esc 跳过');
  });

  it('QuestionDialog：标题用 accent 色', () => {
    setThemeForTests(themePalettes.dark.rich);
    withChalkLevel(3, () => {
      const output = renderToString(
        <QuestionDialog
          request={{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }] }}
          onReply={() => {}}
        />,
      );
      expect(output).toContain(hexToSgr(themePalettes.dark.rich.accent));
    });
  });

  it('PlanApprovalDialog：统一键位提示行，标题/边框用 permissionMode.plan 色', () => {
    expect(
      renderToString(<PlanApprovalDialog request={{ id: 'p1', plan: '# 计划' }} onReply={() => {}} />),
    ).toContain('←→ 移动 · 1/2 直选 · Enter 确认 · Esc 拒绝');

    setThemeForTests(themePalettes.dark.rich);
    withChalkLevel(3, () => {
      const output = renderToString(
        <PlanApprovalDialog request={{ id: 'p1', plan: '# 计划' }} onReply={() => {}} />,
      );
      expect(output).toContain(hexToSgr(themePalettes.dark.rich.permissionMode.plan));
    });
  });
});

describe('PromptInput 细节', () => {
  it('idle：> 前缀用 promptMarker 色；busy：前缀变 dim 提示正在运行', () => {
    setThemeForTests(themePalettes.dark.rich);
    withChalkLevel(3, () => {
      const idle = renderToString(
        <PromptInput busy={false} queuedCount={0} disabled={false} onSubmit={() => {}} />,
      );
      expect(idle).toContain(`${hexToSgr(themePalettes.dark.rich.promptMarker)}> `);

      const busy = renderToString(
        <PromptInput busy={true} queuedCount={0} disabled={false} onSubmit={() => {}} />,
      );
      expect(busy).toContain('\x1b[2m> ');
      expect(busy).toContain('turn 进行中，输入将进入队列…');
    });
  });

  it('排队计数样式统一（dim）', () => {
    withChalkLevel(1, () => {
      const output = renderToString(
        <PromptInput busy={true} queuedCount={2} disabled={false} onSubmit={() => {}} />,
      );
      expect(output).toContain('\x1b[2m  +2 条消息排队中');
    });
  });
});

/** 空会话 App 夹具：cwd 取无「Misty」前缀的路径，banner 名称行断言不被底栏 basename 干扰 */
function makeEmptySessionApp(provider: FakeProvider): { session: Session; registry: ReturnType<typeof createBuiltinRegistry> } {
  const registry = createBuiltinRegistry();
  const session = new Session({
    provider,
    model: 'fake-model',
    systemPrompt: 'system',
    tools: registry.list(),
    cwd: '/tmp/zenwork',
  });
  return { session, registry };
}

describe('App 欢迎头与空态', () => {
  it('空会话：banner（名称行 + 提示行）与输入框上方的空态提示上屏', () => {
    const { session, registry } = makeEmptySessionApp(new FakeProvider([]));
    const output = renderToString(
      <App session={session} registry={registry} model="fake-model" cwd="/tmp/zenwork" />,
    );
    const lines = visibleLines(output);
    expect(lines[0]).toBe('Misty');
    expect(lines[1]).toContain('fake-model · ? default · Shift+Tab 切换权限模式 · /help 查看命令');
    expect(output).toContain('输入消息开始，/help 查看命令');
    expect(output).toContain('输入消息，Enter 发送');
    expect(output).toContain('zenwork');
  });

  it('有消息后 banner 与空态提示消失', async () => {
    const { session, registry } = makeEmptySessionApp(new FakeProvider([textStep('收到')]));
    const { lastFrame, stdin } = renderTestingLibrary(
      <App session={session} registry={registry} model="fake-model" cwd="/tmp/zenwork" />,
    );
    expect(lastFrame()).toContain('Shift+Tab 切换权限模式');
    expect(lastFrame()).toContain('输入消息开始');
    // 输入文本必须不在 banner 里出现（否则 waitFor 立即放行，后续 \r 会覆盖未消费的击键）
    stdin.write('问候一下');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('问候一下');
    });
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('收到');
    });
    expect(lastFrame()).not.toContain('Shift+Tab 切换权限模式');
    expect(lastFrame()).not.toContain('输入消息开始');
  });
});

describe('legacy-cjk 虚拟终端：欢迎头与反色底栏无残帧', () => {
  it('空态帧各物理行 ≤ 列数-1 且底栏单行；turn 完成后 banner 退场、底栏唯一、无大片空白', async () => {
    setTerminalWidthModeForTests('legacy-cjk');
    const stdout = new VirtualTerminal(120, 30, 'legacy-cjk');
    const stderr = new VirtualTerminal(120, 30, 'legacy-cjk');
    const stdin = new FakeTtyStdin();
    const registry = createBuiltinRegistry();
    const session = new Session({
      provider: new FakeProvider([textStep('你好')]),
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
    });
    const instance = render(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
      },
    );
    try {
      await sleep(100);
      const idle = stdout.content();
      // 欢迎头与空态提示
      expect(idle.split('\n').some((line) => line === 'Misty')).toBe(true);
      expect(idle).toContain('Shift+Tab 切换权限模式');
      expect(idle).toContain('输入消息开始');
      // 底栏单行：basename/模型/模式在同一物理行内（折行会把模式挤到下一行）
      const idleBar = idle.split('\n').find((line) => line.includes('MistyAgent'))!;
      expect(idleBar).toContain('fake-model');
      expect(idleBar).toContain('? default');
      // 每一物理行都在 列数-1 预算内
      for (const line of idle.split('\n')) {
        expect(measureTerminalWidth(line, 'legacy-cjk')).toBeLessThanOrEqual(119);
      }

      stdin.write('go');
      await sleep(100);
      stdin.write('\r');
      await waitForText(stdout, '你好');
      await sleep(300);
      const content = stdout.content();
      // 底栏唯一且仍是单行（含 token 用量右簇）
      expect(occurrences(content, 'MistyAgent  fake-model')).toBe(1);
      const bar = content.split('\n').find((line) => line.includes('MistyAgent'))!;
      expect(bar).toContain('? default');
      expect(bar).toContain('↑');
      // banner 与空态提示随首条消息退场
      expect(content).not.toContain('Shift+Tab 切换权限模式');
      expect(content).not.toContain('输入消息开始');
      // 动态区重绘无残帧空白累积
      expect(maxBlankRun(content)).toBeLessThanOrEqual(2);
    } finally {
      instance.unmount();
    }
  }, 15_000);
});
