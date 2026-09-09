import { describe, expect, it } from 'vitest';

import { getBundledSkillDefinitions } from '#/core/skills/bundled';

describe('getBundledSkillDefinitions', () => {
  it('包含内置 skillify，字段完整', () => {
    const definitions = getBundledSkillDefinitions();
    const skillify = definitions.find((d) => d.name === 'skillify');
    expect(skillify).toBeDefined();
    expect(skillify?.source).toBe('bundled');
    expect(skillify?.description).toContain('reusable skill');
    expect(skillify?.whenToUse).toContain('skillify');
    expect(skillify?.argumentHint).toBe('[process description]');
    expect(skillify?.body.length).toBeGreaterThan(0);
  });

  it('skillify 正文覆盖关键步骤：分析 / 采访 / 保存位置 / 确认', () => {
    const body = getBundledSkillDefinitions().find((d) => d.name === 'skillify')!.body;
    expect(body).toContain('$ARGUMENTS');
    expect(body).toContain('Analyze');
    expect(body).toContain('Interview');
    expect(body).toContain('where to save it');
    expect(body).toContain('Confirm');
    expect(body).toContain('ask_user');
    expect(body).toContain('.misty/skills/');
    expect(body).toContain('when_to_use');
  });
});
