import type { SkillDefinition } from './types';

const SKILLIFY_BODY = `# Skillify：把本会话的可重复流程固化为技能

用户对流程的描述（可能为空）：$ARGUMENTS

你要把本会话刚完成的可重复流程捕获为一个可复用 skill。该 skill 在主会话内联执行——会话历史就在你当前的上下文里，直接回顾分析即可，不要做摘要注入。

## 第一步：分析当前会话

提问之前，先回顾本会话，识别：
- 完成了什么可重复流程
- 流程的输入参数
- 按顺序的各步骤
- 每步的成功标准（不是"写了代码"这种模糊说法，而是可验证的产物，如"PR 已打开且 CI 全绿"）
- 用户在哪些地方纠正或引导了你
- 用到了哪些工具

## 第二步：用 ask_user 分轮采访

所有提问都走 ask_user 工具，不要用普通文本提问。信息够了就停，简单流程不要过度提问。

- 第一轮：根据分析给出技能名与描述的建议，请用户确认或改名。
- 第二轮：确认保存位置——项目级 \`.misty/skills/<name>/SKILL.md\`（本仓库专属流程）或用户级 \`~/.misty/skills/<name>/SKILL.md\`（跨仓库通用流程）；确认技能参数（正文用 \`$ARGUMENTS\` 占位）与触发语。
- 第三轮起：逐步确认每步的成功标准；对不可逆操作（合并、发送、删除）确认是否需要用户检查点。

特别注意会话中用户纠正你的地方，之后把它们写成技能的硬性规则。

## 第三步：写 SKILL.md

在用户选定的保存位置创建目录与文件，格式：

\`\`\`markdown
---
name: <技能名>
description: <一句话描述>
when_to_use: <何时自动调用：以"当用户想……时使用"开头，附触发语与示例用户消息>
argument-hint: <参数占位提示；无参数则省略该行>
---

# <技能标题>

## Goal
流程目标，最好带可验证的完成产物。

## Steps

### 1. <步骤名>
具体、可执行的说明，必要时给出命令。

**Success criteria**: 每步必写，表明该步完成、可进入下一步。

## Rules
从用户纠偏中提炼的硬性规则（可选）。
\`\`\`

## 第四步：确认并保存

写文件前，先把完整 SKILL.md 内容贴出给用户过目，用 ask_user 确认后再保存。保存后告知用户：
- 技能保存在哪里
- 以后意图命中该技能的 when_to_use/description 时，你会经 skill 工具自动调用它
- 用户可随时直接编辑该 SKILL.md 调整
`;

/** 内置技能：随发布自带，无需落盘 */
export function getBundledSkillDefinitions(): SkillDefinition[] {
  return [
    {
      name: 'skillify',
      description: '把本会话的可重复流程捕获为可复用 skill',
      whenToUse: '用户想保存/固化刚完成的流程时（触发语如『做成 skill』『保存这个流程』『skillify』）',
      argumentHint: '[流程描述]',
      body: SKILLIFY_BODY,
      source: 'bundled',
    },
  ];
}
