import { Command, Option } from 'commander';

import { permissionModeSchema, type PermissionMode, type Settings } from '#/config/schema';
import {
  loadSettings,
  resolveProviderConfig,
  type LoadedSettings,
  type SettingsOverrides,
} from '#/config/settings';
import { buildSystemPrompt } from '#/core/context/system-prompt';
import { McpManager } from '#/core/mcp/manager';
import type { PlanModeHost } from '#/core/plan-mode';
import { Session, type SessionConfig } from '#/core/session/session';
import {
  listSessions,
  resumeSession,
  type ResumedSession,
  type SessionSummary,
} from '#/core/session/transcript';
import { loadSubagentDefinitions } from '#/core/subagents';
import { TodoStore } from '#/core/todos';
import { TaskManager } from '#/core/tasks';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { errorMessage } from '#/core/errors';
import { createProvider, type ProviderConfig } from '#/provider/factory';

import { runPrintMode } from './print-mode';
import { exitProcess } from './exit-process';

interface CliOptions {
  model?: string;
  baseUrl?: string;
  mode?: PermissionMode;
  print?: string;
  continue?: boolean;
  resume?: string | boolean;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** process.exit 前冲刷 stdout/stderr，避免管道场景尾部输出被截断 */
function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => {
      resolve();
    });
  });
}

function flushStreams(): Promise<void> {
  return Promise.all([flush(process.stdout), flush(process.stderr)]).then(() => undefined);
}

function buildOverrides(options: CliOptions): SettingsOverrides {
  const provider: NonNullable<SettingsOverrides['provider']> = {};
  if (options.baseUrl !== undefined) {
    provider.baseURL = options.baseUrl;
  }
  if (options.model !== undefined) {
    provider.defaultModel = options.model;
  }
  const overrides: SettingsOverrides = { provider };
  if (options.mode !== undefined) {
    overrides.permissionMode = options.mode;
  }
  return overrides;
}

function buildSessionConfig(settings: Settings, cwd: string): Omit<SessionConfig, 'provider' | 'tools'> {
  const permission: NonNullable<SessionConfig['permission']> = {};
  if (settings.permissionMode !== undefined) {
    permission.mode = settings.permissionMode;
  }
  if (settings.permissionRules !== undefined) {
    permission.rules = settings.permissionRules;
  }
  return {
    model: settings.provider.defaultModel,
    systemPrompt: buildSystemPrompt(cwd),
    cwd,
    permission,
    transcript: {},
    maxContextTokens: settings.maxContextTokens,
    hooks: settings.hooks,
  };
}

function formatSessionLine(session: SessionSummary): string {
  const date = new Date(session.mtimeMs).toLocaleString();
  const summary = session.summary === '' ? '（无消息）' : session.summary;
  return `  ${session.sessionId.slice(0, 8)}  ${date}  ${summary}`;
}

/**
 * 解析 --continue / --resume：
 * - 返回 'listed'：已列出候选会话，调用方直接退出（让用户用 --resume <id> 重选）
 * - 返回 null：没有可恢复的会话，开始新会话
 */
function resolveResumeTarget(options: CliOptions, cwd: string): SessionSummary | null | 'listed' {
  if (options.continue === true) {
    const sessions = listSessions(cwd);
    if (sessions.length === 0) {
      console.error('当前目录没有可恢复的会话，开始新会话');
      return null;
    }
    return sessions[0]!;
  }
  if (options.resume === undefined) {
    return null;
  }
  const sessions = listSessions(cwd);
  if (options.resume === true) {
    if (sessions.length === 0) {
      console.error('当前目录没有可恢复的会话，开始新会话');
      return null;
    }
    if (sessions.length === 1) {
      return sessions[0]!;
    }
    console.error('当前目录有多个会话：');
    for (const session of sessions) {
      console.error(formatSessionLine(session));
    }
    console.error('请用 --resume <sessionId> 指定（可只填前缀）');
    return 'listed';
  }
  if (typeof options.resume !== 'string') {
    // 不可达：--resume [sessionId] 只会是 string | true（true 已在上面处理）
    return null;
  }
  const id = options.resume;
  const matches = sessions.filter(
    (session) => session.sessionId === id || session.sessionId.startsWith(id),
  );
  if (matches.length === 0) {
    fail(`当前目录没有会话 ${id}（--resume 不带参数可列出全部会话）`);
  }
  if (matches.length > 1) {
    fail(`会话 id 前缀 ${id} 匹配到多个会话，请填更长前缀`);
  }
  return matches[0]!;
}

async function action(options: CliOptions): Promise<void> {
  const cwd = process.cwd();

  let loaded: LoadedSettings;
  try {
    loaded = loadSettings(cwd, buildOverrides(options));
  } catch (error) {
    fail(errorMessage(error));
  }
  for (const warning of loaded.warnings) {
    console.error(`⚠ ${warning}`);
  }

  const resumeTarget = resolveResumeTarget(options, cwd);
  if (resumeTarget === 'listed') {
    await flushStreams();
    exitProcess(0);
    return;
  }
  let resumed: ResumedSession | null = null;
  if (resumeTarget !== null) {
    try {
      resumed = resumeSession(resumeTarget.filePath);
    } catch (error) {
      fail(errorMessage(error));
    }
  }

  let providerConfig: ProviderConfig;
  try {
    providerConfig = resolveProviderConfig(loaded.settings);
  } catch (error) {
    fail(
      `${errorMessage(error)}\n` +
        '提示：先设置环境变量，例如 `export MISTY_API_KEY=sk-...`（cmd 用 `set MISTY_API_KEY=...`），' +
        '可选 MISTY_BASE_URL / MISTY_MODEL 指定服务与模型。',
    );
  }

  const provider = createProvider(providerConfig);
  const todoStore = new TodoStore();
  const taskManager = new TaskManager();
  // 自定义子代理定义（~/.misty/agents + <cwd>/.misty/agents）；坏文件降级为 warning
  const subagents = loadSubagentDefinitions(cwd);
  for (const warning of subagents.warnings) {
    console.error(`⚠ ${warning}`);
  }
  // MCP：连接是异步的而 registry/Session 构造是同步的——启动时 await 全部连接
  // （单 server 10s 超时）再进 print/TUI；失败的 server 降级为 warning，不阻断启动
  let mcpManager: McpManager | null = null;
  const mcpServers = loaded.settings.mcpServers;
  if (mcpServers !== undefined && Object.keys(mcpServers).length > 0) {
    mcpManager = new McpManager(mcpServers, cwd);
    for (const warning of await mcpManager.connect()) {
      console.error(`⚠ ${warning}`);
    }
  }
  // agent / ask_user / plan 工具经 sessionRef 闭包取运行期状态（/model 切换、提问挂起、
  // 计划模式状态与计划审批）；这些工具只可能在 turn 进行中运行，此时 sessionRef 必已赋值。
  // print 无头模式不注入提问能力：ask_user 退化为"自行决策"的工具结果；
  // 计划审批在 print 模式始终可用，由 runPrintMode 监听事件后自动拒绝（回喂说明）
  let sessionRef: Session | null = null;
  const planModeHost: PlanModeHost = {
    isPlanMode: () => sessionRef?.isPlanMode() ?? false,
    enterPlanMode: () => sessionRef?.enterPlanMode() ?? false,
    exitPlanMode: (target) => sessionRef?.exitPlanMode(target) ?? false,
    requestPlanApproval: (request, signal) =>
      sessionRef?.requestPlanApproval(request, signal) ??
      Promise.resolve({ approved: false, feedback: '会话尚未就绪，无法提交计划审批' }),
  };
  const registry = createBuiltinRegistry({
    todoStore,
    taskManager,
    provider,
    getModel: () => sessionRef?.getModel() ?? loaded.settings.provider.defaultModel,
    subagents: subagents.definitions,
    // 子代理沿用主会话权限判定（含 /mode 运行时切换）；ask 由子代理侧自动拒绝
    getPermissionContext: () =>
      sessionRef?.getPermissionContext() ?? {
        mode: loaded.settings.permissionMode ?? 'default',
        rules: loaded.settings.permissionRules ?? [],
        sessionApprovals: [],
        cwd,
      },
    askUser:
      options.print === undefined
        ? (request, signal) =>
            sessionRef?.askUser(request, signal) ?? Promise.resolve({ cancelled: true })
        : undefined,
    planMode: planModeHost,
  });
  if (mcpManager !== null) {
    for (const tool of mcpManager.tools()) {
      registry.register(tool);
    }
  }
  const sessionConfig = buildSessionConfig(loaded.settings, cwd);
  if (resumed !== null) {
    sessionConfig.transcript = { sessionId: resumed.sessionId };
    sessionConfig.initialMessages = resumed.messages;
    console.error(`已恢复会话 ${resumed.sessionId.slice(0, 8)}（${resumed.messages.length} 条消息）`);
  }
  const session = new Session({
    ...sessionConfig,
    provider,
    tools: registry.list(),
    todos: todoStore,
    tasks: taskManager,
  });
  sessionRef = session;

  if (options.print !== undefined) {
    const code = await runPrintMode({ session, registry, prompt: options.print, tasks: taskManager });
    await mcpManager?.close();
    await flushStreams();
    exitProcess(code);
    return;
  }

  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
    await mcpManager?.close();
    fail('TUI 需要交互式终端（TTY）；自动化 / CI 场景请使用 -p, --print <prompt>。');
  }

  // 动态 import：print 模式不加载 ink/react，也避免非 TTY 环境下的初始化开销
  const { startTui } = await import('#/tui/render-app');
  const instance = startTui({
    session,
    registry,
    model: loaded.settings.provider.defaultModel,
    cwd,
    mcpManager: mcpManager ?? undefined,
  });
  await instance.waitUntilExit();
  await mcpManager?.close();
  await flushStreams();
  exitProcess(0);
}

const program = new Command();

program
  .name('misty')
  .description('Misty — 私人定制 CLI coding agent（OpenAI 兼容 API）')
  .version('0.1.0')
  .option('--model <model>', '覆盖默认模型（等价于 MISTY_MODEL）')
  .option('--base-url <url>', '覆盖 API base URL（等价于 MISTY_BASE_URL）')
  .addOption(
    new Option('--mode <mode>', '权限模式').choices(permissionModeSchema.options),
  )
  .option('-p, --print <prompt>', '无头模式：执行一个 prompt，文本流式输出到 stdout 后退出')
  .option('-c, --continue', '恢复当前目录最近一次会话')
  .option('--resume [sessionId]', '恢复指定会话；不带参数时列出候选（多个时选其一）')
  .action((options: CliOptions) => action(options));

try {
  await program.parseAsync();
} catch (error) {
  fail(errorMessage(error));
}
