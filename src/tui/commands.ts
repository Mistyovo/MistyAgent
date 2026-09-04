import { permissionModeSchema, type PermissionMode } from '#/config/schema';
import { errorMessage } from '#/core/errors';
import type { McpServerStatus } from '#/core/mcp/manager';
import type { Session } from '#/core/session/session';

/** 命令执行上下文：session 引用 + TUI 控制能力（notice/clearBlocks/状态栏更新/退出） */
export interface CommandContext {
  session: Session;
  /** turn 进行中（部分命令此时拒绝执行） */
  busy: boolean;
  /** 输出作为系统提示消息进 Static 区 */
  notice(text: string): void;
  clearBlocks(): void;
  /** 切换模型并更新状态栏 */
  setModel(model: string): void;
  /** 切换权限模式并更新状态栏 */
  setMode(mode: PermissionMode): void;
  /** MCP server 状态查询；未配置 MCP 时缺省 */
  mcpServers?: (() => McpServerStatus[]) | undefined;
  exit(): void;
}

export interface SlashCommand {
  /** 不含斜杠的命令名 */
  name: string;
  description: string;
  usage: string;
  execute(args: string, ctx: CommandContext): void | Promise<void>;
}

const help: SlashCommand = {
  name: 'help',
  description: '列出可用命令',
  usage: '/help',
  execute: (_args, ctx) => {
    const lines = slashCommands.map((command) => `  ${command.usage} — ${command.description}`);
    ctx.notice(['可用命令：', ...lines].join('\n'));
  },
};

const clear: SlashCommand = {
  name: 'clear',
  description: '清屏并开始新会话',
  usage: '/clear',
  execute: (_args, ctx) => {
    if (ctx.busy) {
      ctx.notice('turn 进行中，无法清屏；先 Esc 中断当前 turn');
      return;
    }
    ctx.session.newSession();
    ctx.clearBlocks();
    ctx.notice('已开始新会话');
  },
};

const model: SlashCommand = {
  name: 'model',
  description: '切换模型（仅运行时生效，不改配置文件）',
  usage: '/model <name>',
  execute: (args, ctx) => {
    if (args === '') {
      ctx.notice(`当前模型：${ctx.session.getModel()}`);
      return;
    }
    ctx.setModel(args);
    ctx.notice(`已切换模型：${args}`);
  },
};

const mode: SlashCommand = {
  name: 'mode',
  description: '切换权限模式（无参数时显示当前模式）',
  usage: `/mode <${permissionModeSchema.options.join('|')}>`,
  execute: (args, ctx) => {
    if (args === '') {
      ctx.notice(`当前权限模式：${ctx.session.getPermissionMode()}`);
      return;
    }
    const parsed = permissionModeSchema.safeParse(args);
    if (!parsed.success) {
      ctx.notice(`无效模式：${args}（可选：${permissionModeSchema.options.join(', ')}）`);
      return;
    }
    ctx.setMode(parsed.data);
    ctx.notice(`已切换权限模式：${parsed.data}`);
  },
};

const compact: SlashCommand = {
  name: 'compact',
  description: '手动压缩上下文历史',
  usage: '/compact',
  execute: async (_args, ctx) => {
    if (ctx.busy) {
      ctx.notice('turn 进行中，无法压缩；先 Esc 中断当前 turn');
      return;
    }
    const compacted = await ctx.session.compactNow();
    // 成功时 session 会 dispatch compacted 事件，reducer 落提示块
    if (!compacted) {
      ctx.notice('历史太短或摘要生成失败，未压缩');
    }
  },
};

const exit: SlashCommand = {
  name: 'exit',
  description: '退出 misty',
  usage: '/exit',
  execute: (_args, ctx) => {
    ctx.exit();
  },
};

const mcp: SlashCommand = {
  name: 'mcp',
  description: '列出 MCP server 连接状态与工具数',
  usage: '/mcp',
  execute: (_args, ctx) => {
    const statuses = ctx.mcpServers?.() ?? [];
    if (statuses.length === 0) {
      ctx.notice('未配置 MCP server（在 settings.json 的 mcpServers 字段中配置）');
      return;
    }
    const lines = statuses.map((status) => {
      if (status.state === 'connected') {
        return `  ✓ ${status.name} — 已连接，${status.toolCount} 个工具`;
      }
      const label = status.state === 'failed' ? '连接失败' : '已断开';
      return `  ✗ ${status.name} — ${label}${status.error === undefined ? '' : `：${status.error}`}`;
    });
    ctx.notice(['MCP servers：', ...lines].join('\n'));
  },
};

export const slashCommands: SlashCommand[] = [help, clear, model, mode, compact, mcp, exit];

export function isSlashCommand(text: string): boolean {
  // 含换行的输入不判命令：单行输入敲不出 \n（Enter 即提交），多行文本只会来自
  // 粘贴或 Alt+Enter/`\` 续行——粘贴的 / 开头文本（如多行路径、日志）按普通消息提交。
  // 单行未知命令仍只提示不进模型（现状语义）：命令敲错应得到反馈，而不是静默发给模型。
  return !text.includes('\n') && text.trim().startsWith('/');
}

/** 解析并执行斜杠命令；调用前需用 isSlashCommand 判定 */
export async function runSlashCommand(text: string, ctx: CommandContext): Promise<void> {
  const body = text.trim().slice(1);
  const spaceIndex = body.indexOf(' ');
  const name = (spaceIndex === -1 ? body : body.slice(0, spaceIndex)).toLowerCase();
  const args = spaceIndex === -1 ? '' : body.slice(spaceIndex + 1).trim();
  const command = slashCommands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    ctx.notice(`未知命令：/${name}（/help 查看可用命令）`);
    return;
  }
  try {
    await command.execute(args, ctx);
  } catch (error) {
    ctx.notice(`命令 /${name} 执行失败：${errorMessage(error)}`);
  }
}
