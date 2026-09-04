import chalk, { type ColorSupportLevel } from 'chalk';
import { renderToString } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';

import { permissionModeMeta } from '#/core/permission/modes';
import { permissionModeSchema } from '#/config/schema';
import { MessageList } from '#/tui/components/MessageList';
import { StatusBar } from '#/tui/components/StatusBar';
import type { UiBlock } from '#/tui/controllers/session-reducer';
import {
  detectColorCapability,
  getTheme,
  setThemeForTests,
  themePalettes,
  type Theme,
} from '#/tui/theme';

/** ink 命名色（任务约定 basic 色板只允许这些） */
const NAMED_COLORS = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
]);

/** 收集主题里所有颜色 token 值（跳过 name/variant/capability 元字段） */
function themeColorValues(theme: Theme): string[] {
  const values: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      values.push(node);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  };
  const { name: _name, variant: _variant, capability: _capability, ...colors } = theme;
  walk(colors);
  return values;
}

/** chalk 对 hex 前景色生成的真彩 SGR 序列前缀 */
function hexToSgr(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

afterEach(() => {
  setThemeForTests(null);
});

describe('detectColorCapability', () => {
  it('COLORTERM=truecolor/24bit（大小写不敏感）判为真彩', () => {
    expect(detectColorCapability({ COLORTERM: 'truecolor' })).toBe('rich');
    expect(detectColorCapability({ COLORTERM: '24bit' })).toBe('rich');
    expect(detectColorCapability({ COLORTERM: 'TRUECOLOR' })).toBe('rich');
  });

  it('Windows Terminal / TERM_PROGRAM 系现代终端判为真彩', () => {
    expect(detectColorCapability({ WT_SESSION: 'guid' })).toBe('rich');
    expect(detectColorCapability({ TERM_PROGRAM: 'vscode' })).toBe('rich');
  });

  it('无任何标记（老式 conhost 等）降级 basic', () => {
    expect(detectColorCapability({})).toBe('basic');
    expect(detectColorCapability({ COLORTERM: 'yes' })).toBe('basic');
  });
});

describe('色板约束', () => {
  it('basic 色板只含命名色，绝不允许 hex', () => {
    const values = themeColorValues(themePalettes.dark.basic);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.startsWith('#'), `basic token ${value} 不应是 hex`).toBe(false);
      expect(NAMED_COLORS.has(value), `basic token ${value} 应是 ink 命名色`).toBe(true);
    }
  });

  it('rich 色板只含 hex 或命名色', () => {
    for (const value of themeColorValues(themePalettes.dark.rich)) {
      expect(
        value.startsWith('#') || NAMED_COLORS.has(value),
        `rich token ${value} 非法`,
      ).toBe(true);
    }
    expect(themePalettes.dark.rich.accent.startsWith('#')).toBe(true);
  });

  it('两套色板都覆盖全部权限模式；basic 与 core 语义色名一致', () => {
    for (const mode of permissionModeSchema.options) {
      expect(themePalettes.dark.basic.permissionMode[mode]).toBe(permissionModeMeta[mode].color);
      expect(themePalettes.dark.rich.permissionMode[mode]).not.toBe('');
    }
  });
});

describe('getTheme', () => {
  it('按终端能力选档；测试注入优先于 env 检测', () => {
    const saved = {
      COLORTERM: process.env.COLORTERM,
      WT_SESSION: process.env.WT_SESSION,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
    };
    try {
      delete process.env.COLORTERM;
      delete process.env.WT_SESSION;
      delete process.env.TERM_PROGRAM;
      setThemeForTests(null);
      expect(getTheme()).toBe(themePalettes.dark.basic);

      process.env.COLORTERM = 'truecolor';
      setThemeForTests(null);
      expect(getTheme()).toBe(themePalettes.dark.rich);

      setThemeForTests(themePalettes.dark.basic);
      expect(getTheme()).toBe(themePalettes.dark.basic);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      setThemeForTests(null);
    }
  });
});

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

describe('组件渲染使用 theme 色', () => {
  const userBlock: UiBlock = { id: 1, kind: 'user', text: '你好' };

  it('basic 主题：用户消息发 green SGR，渲染输出无真彩序列', () => {
    setThemeForTests(themePalettes.dark.basic);
    withChalkLevel(1, () => {
      const output = renderToString(<MessageList blocks={[userBlock]} />);
      expect(output).toContain('\x1b[32m');
      expect(output).not.toContain('38;2;');
    });
  });

  it('rich 主题：用户消息发 userText 对应的真彩 SGR', () => {
    setThemeForTests(themePalettes.dark.rich);
    withChalkLevel(3, () => {
      const output = renderToString(<MessageList blocks={[userBlock]} />);
      expect(output).toContain(hexToSgr(themePalettes.dark.rich.userText));
    });
  });

  it('StatusBar 权限模式色取自主题而非 core 色名', () => {
    setThemeForTests(themePalettes.dark.rich);
    withChalkLevel(3, () => {
      const output = renderToString(
        <StatusBar
          cwd="cwd"
          model="m"
          mode="plan"
          usage={null}
          busy={false}
          runningTasks={0}
          exitArmed={false}
        />,
      );
      expect(output).toContain(hexToSgr(themePalettes.dark.rich.permissionMode.plan));
    });
  });
});
