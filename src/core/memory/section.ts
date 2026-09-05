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
    '# 记忆系统',
    '',
    `你有一个持久的文件记忆系统，目录：\`${dir}\`。该目录已存在——直接用 write 工具写入，不要 mkdir 或检查它是否存在。`,
    '',
    '随时间积累记忆，让未来的对话能完整了解：用户是谁、希望如何协作、哪些做法要避免或延续、工作背后的背景。',
    '',
    '用户明确要求记住某事时，立即保存为最合适的类型；要求忘记时，找到并删除对应条目（主题文件与索引行）。',
    '',
    ...TYPES_SECTION,
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## 如何保存记忆',
    '',
    '保存分两步：',
    '',
    '**第一步**——把记忆写进独立文件（如 `user_role.md`、`feedback_testing.md`），frontmatter 格式：',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `**第二步**——在 \`${MEMORY_INDEX_FILENAME}\` 里加一行指针。${MEMORY_INDEX_FILENAME} 是索引不是记忆——每条一行（约 150 字符以内）：\`- [标题](file.md) — 一句话钩子\`。它没有 frontmatter。永远不要把记忆正文直接写进 ${MEMORY_INDEX_FILENAME}。`,
    '',
    `- ${MEMORY_INDEX_FILENAME} 会一直加载在你的上下文里——超过 ${MAX_INDEX_LINES} 行会被截断，保持索引精简`,
    '- 记忆文件的 name / description / type 与正文保持同步',
    '- 按主题而不是时间组织记忆',
    '- 写新记忆前先检查是否已有可更新的记忆，不要重复',
    '- 发现记忆错误或过时，更新或删除它',
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
  ];

  const index = readMemoryIndex(dir);
  if (index !== null && index.trim() !== '') {
    lines.push('', '## 当前记忆索引', '', truncateIndexContent(index).content);
  }
  return lines.join('\n');
}
