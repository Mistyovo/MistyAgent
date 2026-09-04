import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSubagentDefinitions, parseSubagentMarkdown } from '#/core/subagents';

describe('parseSubagentMarkdown', () => {
  it('解析 frontmatter 字段与正文（tools 逗号分隔）', () => {
    const result = parseSubagentMarkdown(
      'reviewer.md',
      [
        '---',
        'name: reviewer',
        'description: 代码评审代理',
        'tools: read, glob, grep',
        'model: strong-model',
        '---',
        '',
        '你是代码评审子代理。',
        '输出问题清单。',
      ].join('\n'),
    );
    expect(result).toEqual({
      ok: true,
      definition: {
        name: 'reviewer',
        description: '代码评审代理',
        tools: ['read', 'glob', 'grep'],
        model: 'strong-model',
        prompt: '你是代码评审子代理。\n输出问题清单。',
      },
    });
  });

  it('tools 支持 dash 列表形式', () => {
    const result = parseSubagentMarkdown(
      'fixer.md',
      ['---', 'name: fixer', 'description: 修复代理', 'tools:', '  - read', '  - write', '---', '修 bug。'].join(
        '\n',
      ),
    );
    expect(result).toEqual({
      ok: true,
      definition: { name: 'fixer', description: '修复代理', tools: ['read', 'write'], prompt: '修 bug。' },
    });
  });

  it('tools / model 缺省时不落字段', () => {
    const result = parseSubagentMarkdown(
      'a.md',
      ['---', 'name: helper', 'description: 助手', '---', '帮忙。'].join('\n'),
    );
    expect(result).toEqual({
      ok: true,
      definition: { name: 'helper', description: '助手', prompt: '帮忙。' },
    });
  });

  it('CRLF 行尾与引号值容错', () => {
    const result = parseSubagentMarkdown(
      'q.md',
      '---\r\nname: "quoted-agent"\r\ndescription: \'引用值\'\r\n---\r\n正文。\r\n',
    );
    expect(result).toEqual({
      ok: true,
      definition: { name: 'quoted-agent', description: '引用值', prompt: '正文。' },
    });
  });

  it('缺 frontmatter / name / description / 正文时返回 warning', () => {
    const cases: [string, string][] = [
      ['没有 frontmatter', '只有正文，没有元信息。'],
      ['缺 name', '---\ndescription: d\n---\n正文。'],
      ['缺 description', '---\nname: x\n---\n正文。'],
      ['空正文', '---\nname: x\ndescription: d\n---\n'],
    ];
    for (const [label, content] of cases) {
      const result = parseSubagentMarkdown('bad.md', content);
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('bad.md');
      }
    }
  });

  it('非法 name 返回 warning', () => {
    const result = parseSubagentMarkdown(
      'bad.md',
      '---\nname: 中文名\ndescription: d\n---\n正文。',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.warning).toContain('不合法');
    }
  });
});

const def = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n正文 ${name}。`;

describe('loadSubagentDefinitions', () => {
  it('user 与 project 双层加载：project 覆盖同名，非 .md 文件忽略', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'misty-subagents-'));
    const userDir = path.join(root, 'user-agents');
    const projectDir = path.join(root, 'proj', '.misty', 'agents');
    await mkdir(userDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(userDir, 'shared.md'), def('shared', 'user 版'));
    await writeFile(path.join(userDir, 'user-only.md'), def('user-only', '仅 user'));
    await writeFile(path.join(projectDir, 'shared.md'), def('shared', '项目版'));
    await writeFile(path.join(projectDir, 'notes.txt'), '不是 md，忽略');

    const { definitions, warnings } = loadSubagentDefinitions(path.join(root, 'proj'), {
      userAgentsDir: userDir,
    });
    expect(warnings).toEqual([]);
    expect(definitions.map((d) => d.name).toSorted()).toEqual(['shared', 'user-only']);
    expect(definitions.find((d) => d.name === 'shared')?.description).toBe('项目版');
  });

  it('目录不存在静默跳过', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'misty-subagents-empty-'));
    const { definitions, warnings } = loadSubagentDefinitions(root, {
      userAgentsDir: path.join(root, '不存在'),
    });
    expect(definitions).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('坏文件降级为 warning，不影响同目录其他定义', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'misty-subagents-bad-'));
    const projectDir = path.join(root, '.misty', 'agents');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'bad.md'), '没有 frontmatter');
    await writeFile(
      path.join(projectDir, 'good.md'),
      '---\nname: good\ndescription: 好定义\n---\n正文。',
    );

    const { definitions, warnings } = loadSubagentDefinitions(root, {
      userAgentsDir: path.join(root, '不存在'),
    });
    expect(definitions.map((d) => d.name)).toEqual(['good']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bad.md');
  });
});
