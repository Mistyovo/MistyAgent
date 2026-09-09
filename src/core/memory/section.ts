import { ensureMemoryDir, getMemoryDir } from './paths';
import {
  MAX_INDEX_LINES,
  MEMORY_INDEX_FILENAME,
  readMemoryIndex,
  truncateIndexContent,
} from './store';
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION,
  TRUSTING_RECALL_SECTION,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './types';

/**
 * 组装系统提示里的记忆指引段。无论索引是否存在都返回完整指引
 * （何时写/四型/不写什么/怎么写/何时读/漂移验证）；有索引则末尾附其内容。
 * 目录在这里确保存在，模型可直接写入而不必先 mkdir。
 */
export function buildMemorySystemPromptSection(dir = getMemoryDir()): string {
  ensureMemoryDir(dir);
  const lines: string[] = [
    '# Memory system',
    '',
    `You have a persistent file-based memory system at \`${dir}\`. That directory already exists — write to it directly with the write tool; do not mkdir or check whether it exists.`,
    '',
    'Accumulate memories over time so that future conversations fully understand: who the user is, how they want to collaborate, which practices to avoid or continue, and the context behind the work.',
    '',
    'When the user explicitly asks you to remember something, save it immediately as the most suitable type; when they ask you to forget something, find and delete the corresponding entry (both the topic file and the index line).',
    '',
    ...TYPES_SECTION,
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## How to save a memory',
    '',
    'Saving takes two steps:',
    '',
    '**Step one** — write the memory into its own file (e.g. `user_role.md`, `feedback_testing.md`) with this frontmatter format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `**Step two** — add a one-line pointer to \`${MEMORY_INDEX_FILENAME}\`. ${MEMORY_INDEX_FILENAME} is an index, not a memory — one line per entry (about 150 characters or less): \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into ${MEMORY_INDEX_FILENAME}.`,
    '',
    `- ${MEMORY_INDEX_FILENAME} is always loaded into your context — it is truncated past ${MAX_INDEX_LINES} lines, so keep the index lean`,
    '- Keep the name / description / type of a memory file in sync with its body',
    '- Organize memories by topic, not by time',
    '- Before writing a new memory, check whether an existing one can be updated instead of duplicated',
    '- When a memory turns out to be wrong or outdated, update or delete it',
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
  ];

  const index = readMemoryIndex(dir);
  if (index !== null && index.trim() !== '') {
    lines.push('', '## Current memory index', '', truncateIndexContent(index).content);
  }
  return lines.join('\n');
}
