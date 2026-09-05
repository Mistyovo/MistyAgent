/**
 * 记忆类型与提示词常量。记忆只存「无法从当前项目状态推导」的上下文：
 * 代码模式、架构、git 历史、文件结构都可以推导（grep / git / AGENTS.md），不存。
 */

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 把 frontmatter 原始值解析为 MemoryType；非法或缺失返回 undefined（旧文件没有 type 字段也能用） */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  return MEMORY_TYPES.find((t) => t === raw);
}

export const TYPES_SECTION: readonly string[] = [
  '## 记忆类型',
  '',
  '记忆分四种，只存无法从当前项目状态推导的内容：',
  '',
  '- **user**：用户画像——角色、目标、偏好、知识背景。了解到用户的角色或偏好时就保存，用来在未来对话里量身定制协作方式（对资深工程师和编程初学者的讲法应该不同）。不要记带负面评判或与工作无关的内容。',
  '- **feedback**：用户对你工作方式的纠偏与确认——「别这么做」和「就这么做」都记。纠正（「不对」「别这样」）容易注意到；确认（「对，就这样」「保持这种做法」）更安静，也要留意。只记纠正会避开旧错但偏离已验证的做法。正文先写规则本身，再写 **Why:**（用户给的理由，常是过往事故或强偏好）与 **How to apply:**（何时何地生效）两行——知道原因才能在边界情况自己判断，而不是盲从规则。',
  '- **project**：项目动态——谁在做什么、为什么、什么时候截止，这些从代码和 git 历史里看不出来。这类状态变化快，发现变化就更新。保存时把用户口中的相对日期转成绝对日期（「周四」→「2026-03-05」），否则时过境迁就无法解读。',
  '- **reference**：外部系统指针——信息在项目之外的什么地方，例如 bug 跟踪在某个 Linear 项目、反馈在某个 Slack 频道、监控面板在某个 URL。用户提到外部系统或其用途时保存，下次用户引用该系统时知道去哪查。',
];

export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## 不要存什么',
  '',
  '能从当前项目状态推导出来的一律不存：',
  '',
  '- 代码模式、约定、架构、文件路径、项目结构——读代码即可得到。',
  '- git 历史、最近的改动、谁改了什么——`git log` / `git blame` 才是权威。',
  '- 调试方案与修复配方——修复在代码里，背景在 commit message 里。',
  '- AGENTS.md 等文档里已经写明的内容。',
  '- 临时任务状态：进行中的工作、临时状态、当前对话的上下文。',
  '',
  '即使用户明确要求保存，以上排除项依然成立。如果用户要存的是 PR 列表、活动总结之类，先问清楚其中令人意外或不显然的部分是什么——那才值得留。',
];

export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## 何时读取记忆',
  '',
  '- 记忆看似与当前任务相关，或用户提到之前对话里的工作时。',
  '- 用户明确要求你查看、回忆或记住时，必须读记忆。',
  '- 记忆可能随时间过时：把它当作「某个时间点曾经成立」的上下文。基于记忆回答或行动之前，先读相关文件或资源的当前状态验证它仍然成立。记忆与当前观察冲突时信当前观察，并更新或删除过时记忆，而不是照旧行动。',
];

export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## 依据记忆给出建议之前',
  '',
  '提到具体函数、文件或开关的记忆，只断言它「在写入时存在」——它可能已被改名、删除或从未合入。给出建议前：',
  '',
  '- 记忆提到文件路径：确认文件还在。',
  '- 记忆提到函数或开关：grep 确认它还在。',
  '- 用户正要按你的建议行动（而不只是问历史）：先验证再建议。',
  '',
  '「记忆说 X 存在」不等于「X 现在存在」。概括仓库状态的记忆（活动日志、架构快照）冻结在写入那一刻；用户问最近或当前状态时，用 `git log` 或读代码，而不是凭快照回答。',
];

export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{记忆名称}}',
  'description: {{一行简介——未来靠它判断相关性，写具体}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{记忆正文——feedback / project 类型的结构：先写规则或事实，再写 **Why:** 与 **How to apply:** 两行}}',
  '```',
];
