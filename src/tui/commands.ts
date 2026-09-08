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
  /** 记忆目录与索引信息（/memory）；记忆未开启时缺省 */
  memoryInfo?: (() => string) | undefined;
  /** 技能清单（/skills）；无技能时缺省或返回空串 */
  skillsInfo?: (() => string) | undefined;
  /** 检查点清单与回滚（/rewind）；检查点未启用时缺省 */
  rewind?: ((id?: string) => string) | undefined;
  /** /clear 开始新会话时回调（如清空任务级共享证据板）；缺省只重置会话本身 */
  onNewSession?: (() => void) | undefined;
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
  description: 'List available commands',
  usage: '/help',
  execute: (_args, ctx) => {
    const lines = slashCommands.map((command) => `  ${command.usage} — ${command.description}`);
    ctx.notice(['Commands:', ...lines].join('\n'));
  },
};

const clear: SlashCommand = {
  name: 'clear',
  description: 'Clear screen and start a new session',
  usage: '/clear',
  execute: (_args, ctx) => {
    if (ctx.busy) {
      ctx.notice('Turn in progress, cannot clear; press Esc to interrupt first');
      return;
    }
    ctx.onNewSession?.();
    ctx.session.newSession();
    ctx.clearBlocks();
    ctx.notice('Started a new session');
  },
};

const model: SlashCommand = {
  name: 'model',
  description: 'Switch model (runtime only, not persisted to config)',
  usage: '/model <name>',
  execute: (args, ctx) => {
    if (args === '') {
      ctx.notice(`Current model: ${ctx.session.getModel()}`);
      return;
    }
    ctx.setModel(args);
    ctx.notice(`Model switched: ${args}`);
  },
};

const mode: SlashCommand = {
  name: 'mode',
  description: 'Switch permission mode (show current when no argument)',
  usage: `/mode <${permissionModeSchema.options.join('|')}>`,
  execute: (args, ctx) => {
    if (args === '') {
      ctx.notice(`Current permission mode: ${ctx.session.getPermissionMode()}`);
      return;
    }
    const parsed = permissionModeSchema.safeParse(args);
    if (!parsed.success) {
      ctx.notice(`Invalid mode: ${args} (valid: ${permissionModeSchema.options.join(', ')})`);
      return;
    }
    ctx.setMode(parsed.data);
    ctx.notice(`Permission mode switched: ${parsed.data}`);
  },
};

const compact: SlashCommand = {
  name: 'compact',
  description: 'Manually compact context history',
  usage: '/compact',
  execute: async (_args, ctx) => {
    if (ctx.busy) {
      ctx.notice('Turn in progress, cannot compact; press Esc to interrupt first');
      return;
    }
    const compacted = await ctx.session.compactNow();
    // 成功时 session 会 dispatch compacted 事件，reducer 落提示块
    if (!compacted) {
      ctx.notice('History too short or summary failed; nothing compacted');
    }
  },
};

const exit: SlashCommand = {
  name: 'exit',
  description: 'Quit misty',
  usage: '/exit',
  execute: (_args, ctx) => {
    ctx.exit();
  },
};

const mcp: SlashCommand = {
  name: 'mcp',
  description: 'List MCP server connection status and tool counts',
  usage: '/mcp',
  execute: (_args, ctx) => {
    const statuses = ctx.mcpServers?.() ?? [];
    if (statuses.length === 0) {
      ctx.notice('No MCP servers configured (set mcpServers in settings.json)');
      return;
    }
    const lines = statuses.map((status) => {
      if (status.state === 'connected') {
        return `  ✓ ${status.name} — connected, ${status.toolCount} tools`;
      }
      const label = status.state === 'failed' ? 'failed' : 'disconnected';
      return `  ✗ ${status.name} — ${label}${status.error === undefined ? '' : `: ${status.error}`}`;
    });
    ctx.notice(['MCP servers:', ...lines].join('\n'));
  },
};

const memory: SlashCommand = {
  name: 'memory',
  description: 'Show memory directory and current index',
  usage: '/memory',
  execute: (_args, ctx) => {
    if (ctx.memoryInfo === undefined) {
      ctx.notice('Memory is disabled (set "memory": true in settings.json)');
      return;
    }
    ctx.notice(ctx.memoryInfo());
  },
};

const skills: SlashCommand = {
  name: 'skills',
  description: 'List loaded skills',
  usage: '/skills',
  execute: (_args, ctx) => {
    const info = ctx.skillsInfo?.() ?? '';
    if (info === '') {
      ctx.notice(
        'No skills loaded (create ~/.misty/skills/<name>/SKILL.md or .misty/skills/<name>/SKILL.md)',
      );
      return;
    }
    ctx.notice(info);
  },
};

const rewind: SlashCommand = {
  name: 'rewind',
  description: 'List file-change checkpoints, or roll back to one',
  usage: '/rewind [id]',
  execute: (args, ctx) => {
    if (ctx.rewind === undefined) {
      ctx.notice('Checkpoints unavailable');
      return;
    }
    if (args === '') {
      ctx.notice(`${ctx.rewind()}\n/rewind <id> to roll back`);
      return;
    }
    ctx.notice(ctx.rewind(args));
  },
};

export const slashCommands: SlashCommand[] = [help, clear, model, mode, compact, rewind, memory, skills, mcp, exit];

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
    ctx.notice(`Unknown command: /${name} (/help for commands)`);
    return;
  }
  try {
    await command.execute(args, ctx);
  } catch (error) {
    ctx.notice(`Command /${name} failed: ${errorMessage(error)}`);
  }
}
