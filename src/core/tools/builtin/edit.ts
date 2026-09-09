import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath, statKind } from './fs-utils';
import { hasRead, recordWritten, staleFileError } from './read-registry';

const inputSchema = z.object({
  path: z.string().describe('File path, relative to cwd or absolute'),
  old_string: z
    .string()
    .min(1)
    .describe('Exact text to replace; must be unique in the file unless replace_all is set'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence, default false'),
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
    'Replace an exact string in a file: old_string becomes new_string. ' +
    'old_string must match the file character for character (including indentation and blank lines) and occur exactly once — when it is not unique, add a few more lines of context to make it unique. ' +
    'Whitespace or line-ending differences are tolerated by a line-aligned fallback match. Set replace_all to replace every occurrence. ' +
    'You must read the target file first (an unread file is refused); a file changed on disk since you read it must be re-read.',
  inputSchema,
  accesses: (input) => [{ kind: 'write', paths: [input.path] }],
  describeCall: (input) => `Edit ${input.path}`,
  call: async (input, ctx) => {
    const absolute = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, absolute);
    const stats = await statKind(absolute);
    if (!stats.isFile) {
      return errorResult(`File not found: ${shown}`);
    }
    if (!hasRead(absolute)) {
      return errorResult(
        `${shown} has not been read in this session: read it first, then replace based on the real content.`,
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
          `old_string occurs ${occurrences} times in ${shown} and is not unique; ` +
            'add more context to make it unique, or set replace_all',
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
        note = `replaced ${replaceAll ? occurrences : 1} occurrence(s)`;
      } else {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const fileLines = content.split(eol);
        const oldLines = input.old_string.replaceAll('\r\n', '\n').split('\n');
        const starts = findNormalizedLineMatches(fileLines, oldLines);
        if (starts.length === 0) {
          return errorResult(
            `old_string was not found in ${shown} (a whitespace/line-ending tolerant match was already attempted); read the file again to confirm the exact text and retry`,
          );
        }
        if (starts.length > 1 && !replaceAll) {
          return errorResult(
            `old_string matched ${starts.length} places with the tolerant matcher and is not unique; ` +
              'add more context to make it unique, or set replace_all',
          );
        }
        const newLines = input.new_string.replaceAll('\r\n', '\n').split('\n');
        const targets = replaceAll ? starts : [starts[0]!];
        for (let index = targets.length - 1; index >= 0; index -= 1) {
          fileLines.splice(targets[index]!, oldLines.length, ...newLines);
        }
        updated = fileLines.join(eol);
        note = `tolerant match replaced ${targets.length} occurrence(s) (whitespace or line endings differed slightly from the file)`;
      }
      await writeFile(absolute, updated, 'utf8');
      await recordWritten(absolute);
      return { output: `Edited ${shown} (${note})` };
    } catch (error) {
      return errorResult(`Edit failed: ${errorMessage(error)}`);
    }
  },
});
