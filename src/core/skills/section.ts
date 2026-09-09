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
    const when = skill.whenToUse === undefined ? '' : ` (when to use: ${skill.whenToUse})`;
    return `- ${skill.name} — ${skill.description}${when}`;
  });
  return [
    '## Available skills',
    '',
    ...lines,
    '',
    "When the user's intent matches a skill's when_to_use or description, invoke the skill tool (passing name) " +
    'to inject the skill body into the current session and follow it immediately — do not reimplement it by hand. ' +
    'The body may contain $ARGUMENTS placeholders; pass the arguments the user gave through the args parameter.',
  ].join('\n');
}
