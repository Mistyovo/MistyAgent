import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { buildOverrides, collect } from '#/cli/options';

describe('collect', () => {
  it('重复选项按出现顺序累加', () => {
    expect(collect('a', [])).toEqual(['a']);
    expect(collect('b', ['a'])).toEqual(['a', 'b']);
  });
});

describe('--fallback flag 解析', () => {
  it('多次出现按顺序收集为数组', () => {
    const program = new Command();
    program.exitOverride();
    program.option('--fallback <model>', '', collect, [] as string[]);
    program.parse(['node', 'misty', '--fallback', 'm1', '--fallback', 'm2']);
    expect(program.opts()).toEqual({ fallback: ['m1', 'm2'] });
  });

  it('未出现时为空数组，buildOverrides 不设置 fallbackModels', () => {
    expect(buildOverrides({ fallback: [] }).fallbackModels).toBeUndefined();
    expect(buildOverrides({}).fallbackModels).toBeUndefined();
  });
});

describe('buildOverrides', () => {
  it('fallback 数组映射到 fallbackModels（分层合并时拼接在既有链尾）', () => {
    expect(buildOverrides({ fallback: ['m1', 'm2'] }).fallbackModels).toEqual(['m1', 'm2']);
  });

  it('model / baseUrl / mode 映射保持不变', () => {
    const overrides = buildOverrides({
      model: 'm',
      baseUrl: 'https://x',
      mode: 'acceptEdits',
    });
    expect(overrides.provider).toEqual({ defaultModel: 'm', baseURL: 'https://x' });
    expect(overrides.permissionMode).toBe('acceptEdits');
  });
});
