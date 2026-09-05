import { describe, expect, it } from 'vitest';

import { getBundledSkillDefinitions } from '#/core/skills/bundled';

describe('getBundledSkillDefinitions', () => {
  it('包含内置 skillify，字段完整', () => {
    const definitions = getBundledSkillDefinitions();
    const skillify = definitions.find((d) => d.name === 'skillify');
    expect(skillify).toBeDefined();
    expect(skillify?.source).toBe('bundled');
    expect(skillify?.description).toContain('可复用 skill');
    expect(skillify?.whenToUse).toContain('skillify');
    expect(skillify?.argumentHint).toBe('[流程描述]');
    expect(skillify?.body.length).toBeGreaterThan(0);
  });

  it('skillify 正文覆盖关键步骤：分析 / 采访 / 保存位置 / 确认', () => {
    const body = getBundledSkillDefinitions().find((d) => d.name === 'skillify')!.body;
    expect(body).toContain('$ARGUMENTS');
    expect(body).toContain('分析');
    expect(body).toContain('采访');
    expect(body).toContain('保存位置');
    expect(body).toContain('确认');
    expect(body).toContain('ask_user');
    expect(body).toContain('.misty/skills/');
    expect(body).toContain('when_to_use');
  });
});
