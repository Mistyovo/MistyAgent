import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath, statKind } from './fs-utils';
import { hasRead, recordWritten, staleFileError } from './read-registry';

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

const normalizeLine = (line: string): string => line.trim();

/**
 * 精确匹配失败后的行对齐容错匹配：old_string 每行 trim 后与文件行 trim 后逐一相等
 * （行数相同）才算命中，覆盖最常见的模型侧偏差——缩进/行尾空白不一致、CRLF 与 LF
 * 混用。返回全部命中区的起始行下标。
 */
function findNormalizedLineMatches(fileLines: string[], oldLines: string[]): number[] {
  const wanted = oldLines.map(normalizeLine);
  const starts: number[] = [];
  for (let start = 0; start + wanted.length <= fileLines.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (normalizeLine(fileLines[start + offset]!) !== wanted[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      starts.push(start);
    }
  }
  return starts;
}

export const editTool = defineTool({
  name: 'edit',
  description:
    '对文件做精确字符串替换：把 old_string 替换为 new_string。' +
    'old_string 必须与文件内容逐字符一致（含缩进与空行）且恰好出现一次——不唯一时多带几行上下文使其唯一；' +
    '缩进/行尾空白略有偏差时可用行对齐容错匹配兜底。要替换全部出现位置用 replace_all。' +
    '修改前必须先 read 目标文件（未读过的文件会报错）；文件被外部改动后需重新 read。',
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
    if (!hasRead(absolute)) {
      return errorResult(
        `本会话尚未读取过 ${shown}：先 read 该文件，基于真实内容再做替换。`,
      );
    }
    const stale = await staleFileError(absolute, shown);
    if (stale !== null) {
      return stale;
    }
    try {
      const content = await readFile(absolute, 'utf8');
      const replaceAll = input.replace_all ?? false;
      const occurrences = countOccurrences(content, input.old_string);
      let updated: string;
      let note: string;
      if (occurrences > 1 && !replaceAll) {
        return errorResult(
          `old_string 在 ${shown} 中出现 ${occurrences} 次，不唯一；` +
            '请提供更多上下文使其唯一，或设置 replace_all',
        );
      }
      if (occurrences > 0) {
        // 按下标切片替换：String.replace 的替换串会展开 $& 等模式，不能用于字面替换
        if (replaceAll) {
          updated = content.split(input.old_string).join(input.new_string);
        } else {
          const index = content.indexOf(input.old_string);
          updated =
            content.slice(0, index) + input.new_string + content.slice(index + input.old_string.length);
        }
        note = `替换 ${replaceAll ? occurrences : 1} 处`;
      } else {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const fileLines = content.split(eol);
        const oldLines = input.old_string.replaceAll('\r\n', '\n').split('\n');
        const starts = findNormalizedLineMatches(fileLines, oldLines);
        if (starts.length === 0) {
          return errorResult(
            `old_string 未在 ${shown} 中找到（已尝试空白/换行容错匹配）；请重新 read 确认原文后重试`,
          );
        }
        if (starts.length > 1 && !replaceAll) {
          return errorResult(
            `old_string 容错匹配到 ${starts.length} 处，不唯一；` +
              '请提供更多上下文使其唯一，或设置 replace_all',
          );
        }
        const newLines = input.new_string.replaceAll('\r\n', '\n').split('\n');
        const targets = replaceAll ? starts : [starts[0]!];
        for (let index = targets.length - 1; index >= 0; index -= 1) {
          fileLines.splice(targets[index]!, oldLines.length, ...newLines);
        }
        updated = fileLines.join(eol);
        note = `容错匹配替换 ${targets.length} 处（原文空白/换行与文件略有差异）`;
      }
      await writeFile(absolute, updated, 'utf8');
      await recordWritten(absolute);
      return { output: `已编辑 ${shown}（${note}）` };
    } catch (error) {
      return errorResult(`编辑失败：${errorMessage(error)}`);
    }
  },
});
