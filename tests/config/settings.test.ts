import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deepMerge, loadSettings, resolveProviderConfig } from '#/config/settings';

function writeSettings(dir: string, content: unknown): string {
  const mistyDir = join(dir, '.misty');
  mkdirSync(mistyDir, { recursive: true });
  const filePath = join(mistyDir, 'settings.json');
  writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

describe('deepMerge', () => {
  it('嵌套对象递归合并，后者覆盖标量', () => {
    expect(
      deepMerge(
        { provider: { type: 'openai', defaultModel: 'a', baseURL: 'https://x' } },
        { provider: { defaultModel: 'b' } },
      ),
    ).toEqual({ provider: { type: 'openai', defaultModel: 'b', baseURL: 'https://x' } });
  });

  it('数组拼接而非覆盖', () => {
    expect(deepMerge({ rules: [1, 2] }, { rules: [3] })).toEqual({ rules: [1, 2, 3] });
  });

  it('override 中的 undefined 视为未设置', () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('类型不一致时后者覆盖前者', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: 'str' })).toEqual({ a: 'str' });
  });

  it('不修改入参', () => {
    const base = { provider: { defaultModel: 'a' }, rules: [1] };
    const override = { provider: { baseURL: 'https://x' }, rules: [2] };
    deepMerge(base, override);
    expect(base).toEqual({ provider: { defaultModel: 'a' }, rules: [1] });
    expect(override).toEqual({ provider: { baseURL: 'https://x' }, rules: [2] });
  });
});

describe('loadSettings', () => {
  let root: string;
  let userDir: string;
  let projectDir: string;
  let userSettingsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'misty-config-test-'));
    userDir = join(root, 'home');
    projectDir = join(root, 'project');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    userSettingsPath = join(userDir, '.misty', 'settings.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function load(
    cliOverrides: Parameters<typeof loadSettings>[1] = {},
    env: NodeJS.ProcessEnv = {},
  ) {
    return loadSettings(projectDir, cliOverrides, { userSettingsPath, env });
  }

  it('无任何配置层时返回内置默认值', () => {
    const { settings, warnings } = load();
    expect(settings.provider).toEqual({ type: 'openai', defaultModel: 'gpt-5-mini' });
    expect(warnings).toEqual([]);
  });

  it('层级优先级：user < project < 环境变量 < CLI flags', () => {
    writeSettings(userDir, {
      provider: { defaultModel: 'user-model', baseURL: 'https://user.example.com' },
      maxTokens: 1000,
    });
    writeSettings(projectDir, { provider: { defaultModel: 'project-model' } });

    const fromFiles = load();
    expect(fromFiles.settings.provider.defaultModel).toBe('project-model');
    expect(fromFiles.settings.provider.baseURL).toBe('https://user.example.com');
    expect(fromFiles.settings.maxTokens).toBe(1000);

    const fromEnv = load({}, { MISTY_MODEL: 'env-model' });
    expect(fromEnv.settings.provider.defaultModel).toBe('env-model');

    const fromCli = load({ provider: { defaultModel: 'cli-model' } }, { MISTY_MODEL: 'env-model' });
    expect(fromCli.settings.provider.defaultModel).toBe('cli-model');
  });

  it('环境变量映射：MISTY_API_KEY 优先于 OPENAI_API_KEY', () => {
    const misty = load({}, { MISTY_API_KEY: 'sk-misty', OPENAI_API_KEY: 'sk-openai' });
    expect(misty.settings.provider.apiKey).toBe('sk-misty');

    const fallback = load({}, { OPENAI_API_KEY: 'sk-openai' });
    expect(fallback.settings.provider.apiKey).toBe('sk-openai');

    const urls = load({}, { MISTY_BASE_URL: 'https://env.example.com' });
    expect(urls.settings.provider.baseURL).toBe('https://env.example.com');
  });

  it('settings.json 中的 apiKey 被警告并忽略', () => {
    writeSettings(userDir, { provider: { apiKey: 'sk-leaked', defaultModel: 'user-model' } });
    const { settings, warnings } = load();
    expect(settings.provider.apiKey).toBeUndefined();
    expect(settings.provider.defaultModel).toBe('user-model');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('apiKey');
  });

  it('非法 JSON 的配置文件降级为警告并跳过', () => {
    writeSettings(projectDir, '{ not json');
    const { settings, warnings } = load();
    expect(settings.provider.defaultModel).toBe('gpt-5-mini');
    expect(warnings).toHaveLength(1);
  });

  it('permissionRules 跨层拼接', () => {
    writeSettings(userDir, { permissionRules: [{ action: 'allow', tool: 'read_file' }] });
    writeSettings(projectDir, {
      permissionRules: [{ action: 'deny', tool: 'write_file', pattern: '*.env' }],
    });
    const { settings } = load();
    expect(settings.permissionRules).toEqual([
      { action: 'allow', tool: 'read_file' },
      { action: 'deny', tool: 'write_file', pattern: '*.env' },
    ]);
  });

  it('合并结果不合法时抛错', () => {
    writeSettings(projectDir, { temperature: 5 });
    expect(() => load()).toThrowError(/配置无效/);
  });
});

describe('resolveProviderConfig', () => {
  it('缺少 API key 时抛错', () => {
    expect(() =>
      resolveProviderConfig({ provider: { type: 'openai', defaultModel: 'm' } }),
    ).toThrowError(/API key/);
  });

  it('生成 ProviderConfig 并透传 baseURL', () => {
    const config = resolveProviderConfig({
      provider: { type: 'openai', defaultModel: 'm', apiKey: 'sk-x', baseURL: 'https://b' },
    });
    expect(config).toEqual({ type: 'openai', apiKey: 'sk-x', baseURL: 'https://b' });
  });

  it('baseURL 未设置时不出现在配置里', () => {
    const config = resolveProviderConfig({
      provider: { type: 'openai', defaultModel: 'm', apiKey: 'sk-x' },
    });
    expect(config.baseURL).toBeUndefined();
  });
});
