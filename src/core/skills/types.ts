/** 技能定义（SKILL.md）：frontmatter 元信息 + 正文指令模板 */
export interface SkillDefinition {
  /** 必填，成为 skill 工具 name 参数的取值 */
  name: string;
  /** 必填，模型选择技能的依据 */
  description: string;
  /** 何时自动触发（frontmatter when_to_use）；写入 system prompt 技能清单 */
  whenToUse?: string | undefined;
  /** 参数占位提示（frontmatter argument-hint），如 "[流程描述]" */
  argumentHint?: string | undefined;
  /** 正文全文，调用时作为指令注入；可含 $ARGUMENTS 占位符 */
  body: string;
  /** 来源层级：项目级同名覆盖用户级；bundled 为随发布内置 */
  source: 'user' | 'project' | 'bundled';
}
