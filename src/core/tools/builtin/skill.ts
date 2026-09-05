import { z } from 'zod';

import type { SkillDefinition } from '../../skills/types';
import { defineTool, type Tool } from '../tool';

import { errorResult } from './fs-utils';

const inputSchema = z.object({
  name: z.string().describe('要调用的技能名'),
  args: z.string().optional().describe('传给技能的参数，替换正文中的 $ARGUMENTS 占位符'),
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
      '调用一个技能：把该技能的正文作为指令注入当前会话并照其执行。可用技能：\n' +
      skills.map((skill) => `- ${skill.name}：${skill.description}`).join('\n'),
    inputSchema,
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) => `Skill(${input.name})`,
    call: async (input) => {
      const skill = byName.get(input.name);
      if (skill === undefined) {
        return errorResult(`未知技能：${input.name}。可用技能：${names.join('、')}`);
      }
      return { output: skill.body.replaceAll('$ARGUMENTS', input.args ?? '') };
    },
  });
}
