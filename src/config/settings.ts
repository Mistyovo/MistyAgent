import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProviderConfig } from '#/provider/factory';

import {
  defaultSettings,
  settingsSchema,
  type PermissionMode,
  type PermissionRule,
  type Settings,
} from './schema';

/** CLI flags 内存层。刻意不含 apiKey：API key 只允许来自环境变量 */
export interface SettingsOverrides {
  provider?: {
    baseURL?: string;
    defaultModel?: string;
  };
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRule[];
  maxTokens?: number;
  temperature?: number;
}

export interface LoadSettingsOptions {
  /** 默认 ~/.misty/settings.json，测试可注入临时路径 */
  userSettingsPath?: string;
  /** 默认 process.env，测试可注入 */
  env?: NodeJS.ProcessEnv;
}

export interface LoadedSettings {
  settings: Settings;
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 深合并两个配置层：plain object 递归按键合并，数组拼接（后者追加），
 * 其余情况后者覆盖前者；override 中的 undefined 视为未设置。不修改入参。
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return base;
  }
  if (base === undefined) {
    return override;
  }
  if (Array.isArray(base) && Array.isArray(override)) {
    return [...base, ...override];
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = deepMerge(base[key], value);
    }
    return merged;
  }
  return override;
}

function readSettingsFile(
  filePath: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    warnings.push(`配置文件 ${filePath} 不是合法的 JSON，已忽略`);
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    warnings.push(`配置文件 ${filePath} 的内容不是 JSON 对象，已忽略`);
    return undefined;
  }
  if (isPlainObject(parsed.provider) && parsed.provider.apiKey !== undefined) {
    warnings.push(
      `配置文件 ${filePath} 中的 provider.apiKey 已被忽略：API key 只允许来自环境变量 MISTY_API_KEY / OPENAI_API_KEY`,
    );
    const provider = { ...parsed.provider };
    delete provider.apiKey;
    return { ...parsed, provider };
  }
  return parsed;
}

function envLayer(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  const apiKey = env.MISTY_API_KEY !== undefined && env.MISTY_API_KEY !== ''
    ? env.MISTY_API_KEY
    : env.OPENAI_API_KEY;
  if (apiKey !== undefined && apiKey !== '') {
    provider.apiKey = apiKey;
  }
  if (env.MISTY_BASE_URL !== undefined && env.MISTY_BASE_URL !== '') {
    provider.baseURL = env.MISTY_BASE_URL;
  }
  if (env.MISTY_MODEL !== undefined && env.MISTY_MODEL !== '') {
    provider.defaultModel = env.MISTY_MODEL;
  }
  return Object.keys(provider).length > 0 ? { provider } : {};
}

/**
 * 分层加载配置，后者覆盖前者：
 * 内置 default → ~/.misty/settings.json → <cwd>/.misty/settings.json
 * → 环境变量 → CLI flags 内存层。
 * 文件层损坏时降级为警告并跳过；合并结果不合法时抛错。
 */
export function loadSettings(
  cwd: string,
  cliOverrides: SettingsOverrides = {},
  options: LoadSettingsOptions = {},
): LoadedSettings {
  const warnings: string[] = [];
  const userSettingsPath = options.userSettingsPath ?? join(homedir(), '.misty', 'settings.json');
  const projectSettingsPath = join(cwd, '.misty', 'settings.json');

  let merged: unknown = defaultSettings;
  for (const layer of [
    readSettingsFile(userSettingsPath, warnings),
    readSettingsFile(projectSettingsPath, warnings),
    envLayer(options.env ?? process.env),
    cliOverrides,
  ]) {
    merged = deepMerge(merged, layer);
  }

  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`配置无效：${details}`);
  }
  return { settings: parsed.data, warnings };
}

export function resolveProviderConfig(settings: Settings): ProviderConfig {
  const { apiKey, baseURL } = settings.provider;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('未配置 API key：请设置环境变量 MISTY_API_KEY 或 OPENAI_API_KEY');
  }
  return { type: 'openai', apiKey, baseURL };
}
