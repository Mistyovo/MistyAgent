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
  '## Memory types',
  '',
  'There are four kinds of memory, and only content that cannot be derived from the current project state is stored:',
  '',
  '- **user**: The user profile — their role, goals, preferences, and background. Save it whenever you learn about the user\'s role or preferences; it tailors how you collaborate in future conversations (a senior engineer and a programming beginner should be taught differently). Do not record negative judgements or anything unrelated to the work.',
  '- **feedback**: The user\'s corrections and confirmations of how you work — record both "don\'t do that" and "keep doing that". Corrections ("no", "not like that") are easy to notice; confirmations ("yes, exactly", "keep this approach") are quieter but matter just as much. Recording only corrections avoids old mistakes but drifts away from approaches already validated. Write the rule itself first, then two lines: **Why:** (the reason the user gave, often a past incident or a strong preference) and **How to apply:** (when and where it takes effect) — knowing the reason lets you judge edge cases yourself instead of following the rule blindly.',
  '- **project**: Project dynamics — who is doing what, why, and by when; none of that is visible in the code or git history. This kind of state changes quickly, so update it as it changes. When saving, convert relative dates the user mentions into absolute ones ("Thursday" → "2026-03-05"), otherwise they become unreadable with time.',
  '- **reference**: Pointers to external systems — where information lives outside the project, e.g. bug tracking in a particular Linear project, feedback in a Slack channel, a monitoring dashboard at some URL. Save it when the user mentions an external system or its purpose, so you know where to look when they refer to it later.',
];

export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What not to save',
  '',
  'Never store anything derivable from the current project state:',
  '',
  '- Code patterns, conventions, architecture, file paths, project structure — reading the code gives you these.',
  '- Git history, recent changes, who changed what — `git log` / `git blame` are authoritative.',
  '- Debugging approaches and fix recipes — the fix is in the code, the context is in the commit message.',
  '- Anything already written down in AGENTS.md or similar documentation.',
  '- Transient task state: work in progress, temporary conditions, the context of the current conversation.',
  '',
  'These exclusions hold even when the user explicitly asks you to save something. If what they want saved is a list of PRs, an activity summary, or the like, first ask what was surprising or non-obvious about it — that part is what is worth keeping.',
];

export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## When to read memory',
  '',
  '- When a memory looks relevant to the current task, or the user refers to work from an earlier conversation.',
  '- When the user explicitly asks you to check, recall, or remember something, you must read memory.',
  '- Memories go stale over time: treat them as context that was once true. Before answering or acting on a memory, read the current state of the relevant file or resource to confirm it still holds. When a memory conflicts with what you observe now, trust the observation and update or delete the stale memory rather than acting on it.',
];

export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## Before giving advice based on memory',
  '',
  'A memory that mentions a specific function, file, or flag only asserts that it existed when the memory was written — it may since have been renamed, deleted, or never merged. Before giving advice:',
  '',
  '- If the memory names a file path, confirm the file still exists.',
  '- If the memory names a function or flag, grep to confirm it still exists.',
  '- If the user is about to act on your advice (not merely asking about history), verify before advising.',
  '',
  '"The memory says X exists" is not "X exists now". Memories that summarize repository state (activity logs, architecture snapshots) are frozen at the moment they were written; when the user asks about recent or current state, use `git log` or read the code rather than answering from the snapshot.',
];

export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line summary — this is what future recall uses to judge relevance, so be specific}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{memory body — for feedback / project types the structure is: the rule or fact first, then the **Why:** and **How to apply:** lines}}',
  '```',
];
