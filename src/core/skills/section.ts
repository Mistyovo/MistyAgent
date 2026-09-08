import type { SkillDefinition } from './types';

/**
 * system prompt 的技能清单段：无技能时为空串。
 * 每个技能一行（name — description，有 whenToUse 附「何时使用」），
 * 并说明模型经 skill 工具触发技能的方式。
 */
export function buildSkillsSystemPromptSection(skills: readonly SkillDefinition[]): string {
  if (skills.length === 0) {
    return '';
  }
  const lines = skills.map((skill) => {
    const when = skill.whenToUse === undefined ? '' : `（何时使用：${skill.whenToUse}）`;
    return `- ${skill.name} — ${skill.description}${when}`;
  });
  return [
    '## 可用技能',
    '',
    ...lines,
    '',
    '当用户意图命中某技能的 when_to_use 或 description 时，调用 skill 工具（传 name）' +
    '把技能正文注入当前会话并立即照其执行，不要绕开技能手工实现；' +
    '正文可能含 $ARGUMENTS 占位符，用 args 参数传入用户给的参数。',
  ].join('\n');
}
