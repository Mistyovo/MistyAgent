import type { PermissionMode } from '#/config/schema';
import { permissionModeMeta } from '#/core/permission/modes';

/**
 * 主题 token 层。
 *
 * 所有组件的颜色一律从这里取，不再散落硬编码。两套色板：
 * - rich：真彩终端（COLORTERM=truecolor/24bit、Windows Terminal、TERM_PROGRAM
 *   系现代终端）用 hex 精致配色
 * - basic：老式终端（中文 cmd.exe 老式 conhost 等）降级为 ink 命名色，
 *   真彩 hex 在老式终端会被错误量化甚至丢色，此色板绝不允许出现 hex
 *
 * v1 只有暗色一套；Theme.variant 与 themePalettes 的层级（dark → 档位）
 * 即为 light 预留的扩展位。明暗/修饰属性（dimColor/italic/bold）是修饰符，
 * 不属于颜色 token，组件照旧使用。
 */

/** 终端色彩能力档位 */
export type ColorCapability = 'rich' | 'basic';

/** Markdown 渲染预留的 token（渲染器落地前组件不引用） */
export interface MarkdownTheme {
  heading: string;
  bold: string;
  codeInline: string;
  codeBlock: string;
  codeBlockBg: string;
  quote: string;
  listBullet: string;
  link: string;
  diffAdd: string;
  diffRemove: string;
}

export interface Theme {
  /** 主题名（调试/日志用） */
  readonly name: string;
  /** 明暗变体；v1 恒为 'dark' */
  readonly variant: 'dark' | 'light';
  /** 本套色板对应的终端能力档位 */
  readonly capability: ColorCapability;
  /** 正文 */
  text: string;
  /** 弱化文本（占位提示、notice、状态栏等；组件侧多用 dimColor 修饰符表达） */
  dim: string;
  /** 强调主色（选中项、in_progress、提问弹窗） */
  accent: string;
  error: string;
  warning: string;
  success: string;
  /** 用户消息正文 */
  userText: string;
  /** 用户消息 '> ' 前缀符号 */
  userMarker: string;
  /** 工具调用行（完成态） */
  toolHead: string;
  /** 工具输出 */
  toolOutput: string;
  /** 思考文本 */
  reasoning: string;
  /** 输入框 '> ' 前缀 */
  promptMarker: string;
  spinner: string;
  /** 底栏文字 */
  statusBar: string;
  /** 底栏背景（下一步美化用，v1 组件不引用） */
  statusBarBg: string;
  /** 权限模式四色的归口：core 的 modes.ts 只保留语义色名，实际取值由主题决定 */
  permissionMode: Record<PermissionMode, string>;
  markdown: MarkdownTheme;
}

/** basic 档权限模式色直接取自 core 语义色名，保证与 modes.ts 不漂移 */
const basicPermissionModeColors = Object.fromEntries(
  Object.entries(permissionModeMeta).map(([mode, meta]) => [mode, meta.color]),
) as Record<PermissionMode, string>;

const richDark: Theme = {
  name: 'rich-dark',
  variant: 'dark',
  capability: 'rich',
  text: '#e8e6e3',
  dim: '#78716c',
  accent: '#d97757',
  error: '#e5654f',
  warning: '#e0a458',
  success: '#8fbf7f',
  userText: '#ffffff',
  userMarker: '#d97757',
  toolHead: '#e8e6e3',
  toolOutput: '#78716c',
  reasoning: '#8a8580',
  promptMarker: '#d97757',
  spinner: '#d97757',
  statusBar: '#78716c',
  statusBarBg: '#1c1a19',
  permissionMode: {
    default: '#e0a458',
    acceptEdits: '#7fb4c9',
    plan: '#8fb4d9',
    bypassPermissions: '#e5654f',
  },
  markdown: {
    heading: '#d97757',
    bold: '#ffffff',
    codeInline: '#d9a45f',
    codeBlock: '#e8e6e3',
    codeBlockBg: '#211f1e',
    quote: '#78716c',
    listBullet: '#d97757',
    link: '#7fb4c9',
    diffAdd: '#8fbf7f',
    diffRemove: '#e5654f',
  },
};

const basicDark: Theme = {
  name: 'basic-dark',
  variant: 'dark',
  capability: 'basic',
  text: 'white',
  dim: 'gray',
  accent: 'yellow',
  error: 'red',
  warning: 'yellow',
  success: 'green',
  userText: 'white',
  userMarker: 'yellow',
  toolHead: 'white',
  toolOutput: 'gray',
  reasoning: 'gray',
  promptMarker: 'yellow',
  spinner: 'yellow',
  statusBar: 'gray',
  statusBarBg: 'black',
  permissionMode: basicPermissionModeColors,
  markdown: {
    heading: 'yellow',
    bold: 'white',
    codeInline: 'yellow',
    codeBlock: 'white',
    codeBlockBg: 'black',
    quote: 'gray',
    listBullet: 'yellow',
    link: 'cyan',
    diffAdd: 'green',
    diffRemove: 'red',
  },
};

/** 主题注册表：variant → capability → Theme；light 变体在此扩展 */
export const themePalettes = {
  dark: { rich: richDark, basic: basicDark },
} as const;

/** 真彩判定：COLORTERM 显式声明优先，其次现代终端会话标记（与 terminal-text 的宽度模式判定同源） */
export function detectColorCapability(env: NodeJS.ProcessEnv = process.env): ColorCapability {
  const colorterm = env.COLORTERM?.toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') {
    return 'rich';
  }
  if (env.WT_SESSION !== undefined || env.TERM_PROGRAM !== undefined) {
    return 'rich';
  }
  return 'basic';
}

let themeOverride: Theme | null = null;
let detectedTheme: Theme | null = null;

/** 当前主题：测试注入优先，否则按终端能力选档（检测结果缓存，env 运行期不变） */
export function getTheme(): Theme {
  if (themeOverride !== null) {
    return themeOverride;
  }
  detectedTheme ??= themePalettes.dark[detectColorCapability()];
  return detectedTheme;
}

/** 测试注入主题；传 null 恢复自动检测并清掉检测缓存（env 变更后重新判定） */
export function setThemeForTests(theme: Theme | null): void {
  themeOverride = theme;
  detectedTheme = null;
}
