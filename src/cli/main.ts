import { Command, Option } from 'commander';

import { permissionModeSchema, type PermissionMode, type Settings } from '#/config/schema';
import {
  loadSettings,
  resolveProviderConfig,
  type LoadedSettings,
  type SettingsOverrides,
} from '#/config/settings';
import { Session, type SessionConfig } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { errorMessage } from '#/core/errors';
import { createProvider, type ProviderConfig } from '#/provider/factory';

import { runPrintMode } from './print-mode';
import { buildSystemPrompt } from './system-prompt';
import { exitProcess } from './exit-process';

interface CliOptions {
  model?: string;
  baseUrl?: string;
  mode?: PermissionMode;
  print?: string;
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
  };
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
  const registry = createBuiltinRegistry();
  const session = new Session({
    ...buildSessionConfig(loaded.settings, cwd),
    provider,
    tools: registry.list(),
  });

  if (options.print !== undefined) {
    const code = await runPrintMode({ session, registry, prompt: options.print });
    await flushStreams();
    exitProcess(code);
    return;
  }

  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
    fail('TUI 需要交互式终端（TTY）；自动化 / CI 场景请使用 -p, --print <prompt>。');
  }

  // 动态 import：print 模式不加载 ink/react，也避免非 TTY 环境下的初始化开销
  const { startTui } = await import('#/tui/render-app');
  const instance = startTui({
    session,
    registry,
    model: loaded.settings.provider.defaultModel,
    cwd,
  });
  await instance.waitUntilExit();
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
  .action((options: CliOptions) => action(options));

try {
  await program.parseAsync();
} catch (error) {
  fail(errorMessage(error));
}
