import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath, statKind } from './fs-utils';

const inputSchema = z.object({
  path: z.string().describe('文件路径，相对 cwd 或绝对路径'),
  old_string: z.string().min(1).describe('要被替换的原始字符串，必须在文件中唯一（除非 replace_all）'),
  new_string: z.string().describe('替换后的字符串'),
  replace_all: z.boolean().optional().describe('替换所有出现位置，默认 false'),
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const editTool = defineTool({
  name: 'edit',
  description:
    '对文件做精确字符串替换：把 old_string 替换为 new_string。' +
    'old_string 必须恰好出现一次，或用 replace_all 替换全部。',
  inputSchema,
  accesses: (input) => [{ kind: 'write', paths: [input.path] }],
  describeCall: (input) => `Edit ${input.path}`,
  call: async (input, ctx) => {
    const absolute = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, absolute);
    const stats = await statKind(absolute);
    if (!stats.isFile) {
      return errorResult(`文件不存在：${shown}`);
    }
    try {
      const content = await readFile(absolute, 'utf8');
      const occurrences = countOccurrences(content, input.old_string);
      if (occurrences === 0) {
        return errorResult(`old_string 未在 ${shown} 中找到`);
      }
      const replaceAll = input.replace_all ?? false;
      if (occurrences > 1 && !replaceAll) {
        return errorResult(
          `old_string 在 ${shown} 中出现 ${occurrences} 次，不唯一；` +
            '请提供更多上下文使其唯一，或设置 replace_all',
        );
      }
      const updated = replaceAll
        ? content.split(input.old_string).join(input.new_string)
        : content.replace(input.old_string, input.new_string);
      await writeFile(absolute, updated, 'utf8');
      const replaced = replaceAll ? occurrences : 1;
      return { output: `已编辑 ${shown}（替换 ${replaced} 处）` };
    } catch (error) {
      return errorResult(`编辑失败：${errorMessage(error)}`);
    }
  },
});
