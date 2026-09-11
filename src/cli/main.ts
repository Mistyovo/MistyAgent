import { Command, Option } from 'commander';

import { permissionModeSchema, type Settings } from '#/config/schema';
import {
  loadSettings,
  resolveProviderConfig,
  type LoadedSettings,
} from '#/config/settings';
import { TaskBoard } from '#/core/board';
import { CheckpointStore, cleanupCheckpoints } from '#/core/checkpoint/checkpoint';
import { buildSystemPrompt } from '#/core/context/system-prompt';
import { McpManager } from '#/core/mcp/manager';
import { getMemoryDir } from '#/core/memory/paths';
import { buildMemorySystemPromptSection } from '#/core/memory/section';
import { readMemoryIndex } from '#/core/memory/store';
import { cleanupSpilledOutputs } from '#/core/output-spill';
import type { PlanModeHost } from '#/core/plan-mode';
import { Session, type SessionConfig } from '#/core/session/session';
import {
  listSessions,
  resumeSession,
  type ResumedSession,
  type SessionSummary,
} from '#/core/session/transcript';
import { getBundledSkillDefinitions } from '#/core/skills/bundled';
import { loadSkillDefinitions } from '#/core/skills/loader';
import { buildSkillsSystemPromptSection } from '#/core/skills/section';
import type { SkillDefinition } from '#/core/skills/types';
import { loadSubagentDefinitions } from '#/core/subagents';
import { TodoStore } from '#/core/todos';
import { TaskManager } from '#/core/tasks';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { errorMessage } from '#/core/errors';
import { createProvider, type ProviderConfig } from '#/provider/factory';

import { buildOverrides, collect, type CliOptions } from './options';
import { resolveCompetitionClient, runArenaCommand } from './arena';
import { runSmokeCommand } from './smoke';
import { resolvePrintPrompt, runPrintMode } from './print-mode';
import { exitProcess } from './exit-process';

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

function buildSessionConfig(
  settings: Settings,
  cwd: string,
  skills: readonly SkillDefinition[],
): Omit<SessionConfig, 'provider' | 'tools'> {
  const permission: NonNullable<SessionConfig['permission']> = {};
  if (settings.permissionMode !== undefined) {
    permission.mode = settings.permissionMode;
  }
  if (settings.permissionRules !== undefined) {
    permission.rules = settings.permissionRules;
  }
  let systemPrompt = buildSystemPrompt(cwd);
  if (settings.memory === true) {
    systemPrompt += '\n\n' + buildMemorySystemPromptSection();
  }
  if (skills.length > 0) {
    systemPrompt += '\n\n' + buildSkillsSystemPromptSection(skills);
  }
  return {
    model: settings.provider.defaultModel,
    systemPrompt,
    cwd,
    permission,
    transcript: {},
    maxTokens: settings.maxTokens,
    maxContextTokens: settings.maxContextTokens,
    fallbackModels: settings.fallbackModels,
    hooks: settings.hooks,
    memory: { enabled: settings.memory === true },
  };
}

/** /memory 上屏内容：记忆目录路径 + 当前索引内容（无索引说明为空） */
function buildMemoryInfo(): string {
  const dir = getMemoryDir();
  const index = readMemoryIndex();
  if (index === null || index.trim() === '') {
    return `Memory directory: ${dir}\n(index empty: no memories written yet)`;
  }
  return `Memory directory: ${dir}\n\n${index.trim()}`;
}

/** /skills 上屏内容：每行 name — description（标来源层级）；无技能返回空串 */
function buildSkillsInfo(skills: readonly SkillDefinition[]): string {
  if (skills.length === 0) {
    return '';
  }
  const sourceLabel = { user: 'user', project: 'project', bundled: 'built-in' } as const;
  const lines = skills.map(
    (skill) => `  ${skill.name} — ${skill.description} (${sourceLabel[skill.source]})`,
  );
  return ['Loaded skills:', ...lines].join('\n');
}

/** /rewind 无参上屏：检查点清单（id、时间、触发文本、改动文件数） */
function buildCheckpointList(store: CheckpointStore): string {
  const checkpoints = store.list();
  if (checkpoints.length === 0) {
    return 'No rewindable checkpoints';
  }
  const lines = checkpoints.map((checkpoint) => {
    const time = new Date(checkpoint.createdAt).toLocaleTimeString();
    const text = checkpoint.userText.replaceAll('\n', ' ');
    const shown = text.length > 50 ? `${text.slice(0, 50)}…` : text;
    return `  ${checkpoint.id}  ${time}  ${shown} (${checkpoint.files.length} files)`;
  });
  return ['Rewindable checkpoints:', ...lines].join('\n');
}

/** /rewind 回调：无 id 列清单，有 id 回滚并描述结果（还原改动文件、删除 turn 内新建文件） */
function rewindCheckpoints(store: CheckpointStore, id?: string): string {
  if (id === undefined) {
    return buildCheckpointList(store);
  }
  const parsed = Number.parseInt(id, 10);
  if (Number.isNaN(parsed)) {
    return `Invalid checkpoint id: ${id}`;
  }
  const result = store.rewind(parsed);
  if ('error' in result) {
    return result.error;
  }
  return `Rolled back to checkpoint ${parsed}: restored ${result.restored.length} files, deleted ${result.deleted.length} created files`;
}

function formatSessionLine(session: SessionSummary): string {
  const date = new Date(session.mtimeMs).toLocaleString();
  const summary = session.summary === '' ? '(no messages)' : session.summary;
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
      console.error('No resumable session in the current directory; starting a new session');
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
      console.error('No resumable session in the current directory; starting a new session');
      return null;
    }
    if (sessions.length === 1) {
      return sessions[0]!;
    }
    console.error('Multiple sessions in the current directory:');
    for (const session of sessions) {
      console.error(formatSessionLine(session));
    }
    console.error('Specify one with --resume <sessionId> (a prefix is enough)');
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
    fail(`No session ${id} in the current directory (run --resume with no argument to list all sessions)`);
  }
  if (matches.length > 1) {
    fail(`Session id prefix ${id} matches multiple sessions; use a longer prefix`);
  }
  return matches[0]!;
}

async function action(options: CliOptions): Promise<void> {
  const cwd = process.cwd();

  // 清理过期的工具输出落盘文件（os.tmpdir()/misty-output，超 24h 的删除）
  cleanupSpilledOutputs();
  // 清理过期的检查点备份（超 7 天的删除）
  cleanupCheckpoints();

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
        'Hint: put the key in ~/.misty/settings.json, e.g. ' +
        '{"provider":{"type":"openai","apiKey":"sk-...","defaultModel":"...","baseURL":"https://..."}}; ' +
        'project .misty/settings.json overrides the user file.',
    );
  }

  const provider = createProvider(providerConfig);
  const todoStore = new TodoStore();
  const taskManager = new TaskManager();
  const checkpointStore = new CheckpointStore(cwd);
  // 任务级共享证据板：子代理间复用事实/死路；/clear 开新会话时经 onNewSession 清空
  const taskBoard = new TaskBoard();
  // 自定义子代理定义（~/.misty/agents + <cwd>/.misty/agents）；坏文件降级为 warning
  const subagents = loadSubagentDefinitions(cwd);
  for (const warning of subagents.warnings) {
    console.error(`⚠ ${warning}`);
  }
  // 技能定义（~/.misty/skills + <cwd>/.misty/skills，项目级同名覆盖用户级）+ 内置技能；
  // 坏文件降级为 warning
  const loadedSkills = loadSkillDefinitions(cwd);
  for (const warning of loadedSkills.warnings) {
    console.error(`⚠ ${warning}`);
  }
  const skills = [...loadedSkills.definitions, ...getBundledSkillDefinitions()];
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
      Promise.resolve({ approved: false, feedback: 'Session is not ready yet; cannot submit plan approval' }),
  };
  // 赛事平台接入：队伍 token 只走环境变量（MISTY_CTF_TOKEN / CTF_TOKEN），
  // 未设置时不注册 competition_* 工具；MISTY_CTF_BASE_URL / MISTY_CTF_*_PATH
  // 覆盖地址与接口路径（决赛换 hash 零代码切换）。装配与 arena 子命令共享。
  const competition = resolveCompetitionClient(process.env);
  if (competition !== undefined) {
    console.error('Competition tools enabled: competition_list / competition_reset / competition_submit');
  }
  const registry = createBuiltinRegistry({
    todoStore,
    taskManager,
    checkpoints: checkpointStore,
    provider,
    getModel: () => sessionRef?.getModel() ?? loaded.settings.provider.defaultModel,
    subagents: subagents.definitions,
    skills,
    board: taskBoard,
    competition,
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
  const sessionConfig = buildSessionConfig(loaded.settings, cwd, skills);
  if (resumed !== null) {
    sessionConfig.transcript = { sessionId: resumed.sessionId };
    sessionConfig.initialMessages = resumed.messages;
    console.error(`Resumed session ${resumed.sessionId.slice(0, 8)} (${resumed.messages.length} messages)`);
  }
  const session = new Session({
    ...sessionConfig,
    provider,
    tools: registry.list(),
    todos: todoStore,
    tasks: taskManager,
    checkpoints: checkpointStore,
  });
  sessionRef = session;

  if (options.print !== undefined) {
    // stdin 被管道/重定向时拼接到 prompt（git diff | misty -p "review"）；TTY 时原样
    const prompt = await resolvePrintPrompt(options.print);
    const code = await runPrintMode({
      session,
      registry,
      prompt,
      tasks: taskManager,
      outputFormat: options.outputFormat,
      cwd,
    });
    await mcpManager?.close();
    await flushStreams();
    exitProcess(code);
    return;
  }

  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
    await mcpManager?.close();
    fail('TUI requires an interactive terminal (TTY); for automation / CI, use -p, --print <prompt>.');
  }

  // 动态 import：print 模式不加载 ink/react，也避免非 TTY 环境下的初始化开销
  const { startTui } = await import('#/tui/render-app');
  const instance = startTui({
    session,
    registry,
    model: loaded.settings.provider.defaultModel,
    cwd,
    mcpManager: mcpManager ?? undefined,
    memoryInfo: loaded.settings.memory === true ? buildMemoryInfo : undefined,
    skillsInfo: skills.length > 0 ? () => buildSkillsInfo(skills) : undefined,
    rewind: (id) => rewindCheckpoints(checkpointStore, id),
    onNewSession: () => taskBoard.reset(),
  });
  await instance.waitUntilExit();
  await mcpManager?.close();
  await flushStreams();
  exitProcess(0);
}

const program = new Command();

program
  .name('misty')
  .description('Misty — a personal CLI coding agent (OpenAI-compatible API)')
  .version('0.1.0')
  .option('--model <model>', 'Override the default model from settings.json')
  .option(
    '--fallback <model>',
    'Append a fallback model: fall back in the order added when the primary model fails (repeatable, current turn only)',
    collect,
    [] as string[],
  )
  .option('--base-url <url>', 'Override the API base URL from settings.json')
  .addOption(
    new Option('--mode <mode>', 'Permission mode').choices(permissionModeSchema.options),
  )
  .option('-p, --print <prompt>', 'Headless mode: run one prompt, stream text to stdout, then exit')
  .addOption(
    new Option(
      '--output-format <format>',
      'Headless output format: text (human-readable) or stream-json (NDJSON event stream on stdout)',
    ).choices(['text', 'stream-json']),
  )
  .option('-c, --continue', 'Resume the most recent session in the current directory')
  .option('--resume [sessionId]', 'Resume a specific session; without an argument, list candidates (pick one when several match)')
  .action((options: CliOptions) => action(options));

const int = (value: string): number => Number.parseInt(value, 10);

program
  .command('arena')
  .description('One-click CTF sweep: list unsolved questions, solve them in parallel misty processes with watchdog/restart, then emit status and WriteUp material')
  .option('--dir <dir>', 'Working directory for per-question runs (default ./ctf-arena)')
  .option('--concurrency <n>', 'Parallel solver processes (default 3)', int)
  .option('--attempts <n>', 'Max attempts per question incl. restarts (default 2)', int)
  .option('--stall-min <minutes>', 'Treat a solver as stalled after this long without output (default 8)', int)
  .option('--budget-min <minutes>', 'Overall time budget; kill everything when exhausted (default 28)', int)
  .option('--include-solved', 'Also attack questions already solved by the team')
  .option('--only <ids>', 'Comma-separated question_id whitelist (single-question debugging)')
  .option('--misty-cmd <cmd>', 'Command to spawn misty itself, e.g. "npx tsx src/cli/main.ts" when running from source')
  .action(async (options) => {
    process.exitCode = await runArenaCommand(options);
  });

program
  .command('smoke')
  .description('Pre-match smoke test: model endpoint, competition platform, shell/python/pwn toolchain')
  .action(async () => {
    process.exitCode = await runSmokeCommand();
  });

try {
  await program.parseAsync();
} catch (error) {
  fail(errorMessage(error));
}
