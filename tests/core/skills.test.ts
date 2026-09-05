import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSkillDefinitions, parseSkillMarkdown } from '#/core/skills/loader';
import { buildSkillsSystemPromptSection } from '#/core/skills/section';
import type { SkillDefinition } from '#/core/skills/types';

const skillMd = (name: string, description: string, extra: string[] = []): string =>
  ['---', `name: ${name}`, `description: ${description}`, ...extra, '---', `技能 ${name} 的正文。`].join(
    '\n',
  );

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), content);
}

describe('parseSkillMarkdown', () => {
  it('解析 frontmatter 字段与正文，可选字段缺省不落字段', () => {
    const result = parseSkillMarkdown('SKILL.md', skillMd('review', '评审流程'), 'project');
    expect(result).toEqual({
      ok: true,
      definition: {
        name: 'review',
        description: '评审流程',
        body: '技能 review 的正文。',
        source: 'project',
      },
    });
  });

  it('when_to_use / argument-hint 解析为 whenToUse / argumentHint', () => {
    const result = parseSkillMarkdown(
      'SKILL.md',
      skillMd('review', '评审流程', ['when_to_use: 用户要评审时', 'argument-hint: "[范围]"']),
      'user',
    );
    expect(result).toEqual({
      ok: true,
      definition: {
        name: 'review',
        description: '评审流程',
        whenToUse: '用户要评审时',
        argumentHint: '[范围]',
        body: '技能 review 的正文。',
        source: 'user',
      },
    });
  });

  it('缺 frontmatter / name / description / 正文与非法 name 时返回 warning', () => {
    const cases: string[] = [
      '只有正文，没有元信息。',
      '---\ndescription: d\n---\n正文。',
      '---\nname: x\n---\n正文。',
      '---\nname: x\ndescription: d\n---\n',
      '---\nname: 中文名\ndescription: d\n---\n正文。',
    ];
    for (const content of cases) {
      const result = parseSkillMarkdown('bad.md', content, 'project');
      expect(result.ok, content).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('bad.md');
      }
    }
  });
});

describe('loadSkillDefinitions', () => {
  it('user 与 project 双层加载：project 覆盖同名，source 按目录归属', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'misty-skills-'));
    const userDir = path.join(root, 'user-skills');
    const projectDir = path.join(root, 'proj', '.misty', 'skills');
    await mkdir(userDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeSkill(userDir, 'shared', skillMd('shared', 'user 版'));
    await writeSkill(userDir, 'user-only', skillMd('user-only', '仅 user'));
    await writeSkill(projectDir, 'shared', skillMd('shared', '项目版'));
    await writeSkill(projectDir, 'proj-only', skillMd('proj-only', '仅项目'));

    const { definitions, warnings } = loadSkillDefinitions(path.join(root, 'proj'), {
      userSkillsDir: userDir,
    });
    expect(warnings).toEqual([]);
    expect(definitions.map((d) => d.name).toSorted()).toEqual(['proj-only', 'shared', 'user-only']);
    expect(definitions.find((d) => d.name === 'shared')?.description).toBe('项目版');
    expect(definitions.find((d) => d.name === 'user-only')?.source).toBe('user');
    expect(definitions.find((d) => d.name === 'proj-only')?.source).toBe('project');
  });

  it('目录不存在静默跳过；子目录缺 SKILL.md 也跳过', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'misty-skills-empty-'));
    await mkdir(path.join(root, '.misty', 'skills', 'no-skill-md'), { recursive: true });

    const { definitions, warnings } = loadSkillDefinitions(root, {
      userSkillsDir: path.join(root, '不存在'),
    });
    expect(definitions).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('坏文件降级为 warning，不影响同目录其他技能', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'misty-skills-bad-'));
    const projectDir = path.join(root, '.misty', 'skills');
    await mkdir(path.join(projectDir, 'bad'), { recursive: true });
    await writeFile(path.join(projectDir, 'bad', 'SKILL.md'), '没有 frontmatter');
    await writeSkill(projectDir, 'good', skillMd('good', '好技能'));

    const { definitions, warnings } = loadSkillDefinitions(root, {
      userSkillsDir: path.join(root, '不存在'),
    });
    expect(definitions.map((d) => d.name)).toEqual(['good']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SKILL.md');
  });
});

describe('buildSkillsSystemPromptSection', () => {
  const skills: SkillDefinition[] = [
    { name: 'review', description: '评审流程', body: '…', source: 'project' },
    {
      name: 'skillify',
      description: '固化流程',
      whenToUse: '用户想保存流程时',
      body: '…',
      source: 'bundled',
    },
  ];

  it('空数组返回空串', () => {
    expect(buildSkillsSystemPromptSection([])).toBe('');
  });

  it('非空时输出技能清单与触发说明', () => {
    const section = buildSkillsSystemPromptSection(skills);
    expect(section).toContain('review — 评审流程');
    expect(section).toContain('skillify — 固化流程（何时使用：用户想保存流程时）');
    expect(section).toContain('skill 工具');
    expect(section).toContain('$ARGUMENTS');
  });
});
