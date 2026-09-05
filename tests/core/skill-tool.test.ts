import { describe, expect, it } from 'vitest';

import type { SkillDefinition } from '#/core/skills/types';
import { createSkillTool } from '#/core/tools/builtin/skill';
import type { ToolContext } from '#/core/tools/tool';

const skills: SkillDefinition[] = [
  {
    name: 'review',
    description: '评审流程',
    body: '请评审 $ARGUMENTS 的改动。\n$ARGUMENTS 结束后汇总。',
    source: 'project',
  },
  { name: 'fix', description: '修 bug 流程', body: '修复：$ARGUMENTS', source: 'user' },
];

const ctx: ToolContext = { cwd: '.', signal: new AbortController().signal };

describe('createSkillTool', () => {
  const tool = createSkillTool(skills);

  it('命中返回替换 $ARGUMENTS 后的正文（多处占位全部替换）', async () => {
    const result = await tool.call({ name: 'review', args: 'src/' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('请评审 src/ 的改动。\nsrc/ 结束后汇总。');
  });

  it('args 缺省时 $ARGUMENTS 替换为空串', async () => {
    const result = await tool.call({ name: 'fix' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('修复：');
  });

  it('未知技能名返回 isError 与可用清单', async () => {
    const result = await tool.call({ name: 'nope' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('nope');
    expect(result.output).toContain('review');
    expect(result.output).toContain('fix');
  });

  it('describeCall / isReadOnly / accesses / description 清单', () => {
    expect(tool.describeCall({ name: 'review', args: 'x' })).toBe('Skill(review)');
    expect(tool.isReadOnly({ name: 'review' })).toBe(true);
    expect(tool.accesses({ name: 'review' })).toEqual([{ kind: 'read' }]);
    expect(tool.description).toContain('review');
    expect(tool.description).toContain('fix');
  });
});
