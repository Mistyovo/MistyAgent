import { z } from 'zod';

import type { SkillDefinition } from '../../skills/types';
import { defineTool, type Tool } from '../tool';

import { errorResult } from './fs-utils';

const inputSchema = z.object({
  name: z.string().describe('Name of the skill to invoke'),
  args: z
    .string()
    .optional()
    .describe('Arguments passed to the skill, substituted for the $ARGUMENTS placeholder'),
});

/**
 * 技能工具：按名把技能正文（指令模板）注入会话执行，$ARGUMENTS 替换为 args。
 * 技能清单由宿主经 createBuiltinRegistry 闭包注入；正文可能要求模型继续调用
 * 其他工具（如 ask_user / write），本工具自身只读。
 */
export function createSkillTool(skills: readonly SkillDefinition[]): Tool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const names = skills.map((skill) => skill.name);
  return defineTool({
    name: 'skill',
    description:
      'Invoke a skill: injects the skill body into the current session as instructions and you follow them immediately (the body may call for further tool calls). ' +
      'When the user intent matches a skill, go through this tool rather than reimplementing it by hand. Available skills:\n' +
      skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n'),
    inputSchema,
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) => `Skill(${input.name})`,
    call: async (input) => {
      const skill = byName.get(input.name);
      if (skill === undefined) {
        return errorResult(
          `Unknown skill: ${input.name}. Available skills: ${names.join(', ')}`,
        );
      }
      return { output: skill.body.replaceAll('$ARGUMENTS', input.args ?? '') };
    },
  });
}
