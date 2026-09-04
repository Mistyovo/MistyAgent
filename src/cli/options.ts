import type { PermissionMode } from '#/config/schema';
import type { SettingsOverrides } from '#/config/settings';

export interface CliOptions {
  model?: string;
  baseUrl?: string;
  mode?: PermissionMode;
  fallback?: string[];
  print?: string;
  continue?: boolean;
  resume?: string | boolean;
}

/** commander 重复选项收集器：--fallback a --fallback b → ['a', 'b'] */
export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function buildOverrides(options: CliOptions): SettingsOverrides {
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
  if (options.fallback !== undefined && options.fallback.length > 0) {
    overrides.fallbackModels = options.fallback;
  }
  return overrides;
}
