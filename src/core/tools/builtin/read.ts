import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, isBinaryFile, resolvePath, statKind } from './fs-utils';

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const inputSchema = z.object({
  path: z.string().describe('文件路径，相对 cwd 或绝对路径'),
  offset: z.number().int().min(1).optional().describe('起始行号（1 起），默认 1'),
  limit: z.number().int().min(1).optional().describe(`最多读取的行数，默认 ${MAX_LINES}`),
});

function formatBody(lines: string[], offset: number): string {
  return lines
    .map((line, index) => {
      const truncated =
        line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
      return `${offset + index}\t${truncated}`;
    })
    .join('\n');
}

/** 流式读取 [offset, offset+limit) 行段，读满即停，不整文件加载（大文件分段用） */
async function readLineRange(
  absolute: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; hasMore: boolean }> {
  const stream = createReadStream(absolute, 'utf8');
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNumber = 0;
  let hasMore = false;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < offset) {
        continue;
      }
      if (lines.length >= limit) {
        hasMore = true;
        break;
      }
      lines.push(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return { lines, hasMore };
}

export const readTool = defineTool({
  name: 'read',
  description:
    '读取文本文件内容，输出带行号（<行号>\\t<内容>）。' +
    `默认最多 ${MAX_LINES} 行，超长行在 ${MAX_LINE_LENGTH} 字符处截断。` +
    `超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 的文件必须用 offset/limit 分段读取。` +
    '二进制文件与目录不可读。',
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Read ${input.path}`,
  call: async (input, ctx) => {
    const absolute = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, absolute);
    const stats = await statKind(absolute);
    if (stats.missing) {
      return errorResult(`文件不存在：${shown}`);
    }
    if (stats.isDirectory) {
      return errorResult(`路径是目录而不是文件：${shown}`);
    }
    const oversized = stats.size > MAX_FILE_SIZE;
    const segmented = input.offset !== undefined || input.limit !== undefined;
    if (oversized && !segmented) {
      return errorResult(
        `文件过大（${(stats.size / 1024 / 1024).toFixed(1)}MB），超过 ` +
          `${MAX_FILE_SIZE / 1024 / 1024}MB 上限，请用 offset/limit 分段读取：${shown}`,
      );
    }
    try {
      if (await isBinaryFile(absolute)) {
        return errorResult(`文件不是文本文件（检测到二进制内容）：${shown}`);
      }
      const offset = input.offset ?? 1;
      const limit = input.limit ?? MAX_LINES;
      if (oversized) {
        const { lines: slice, hasMore } = await readLineRange(absolute, offset, limit);
        if (slice.length === 0) {
          return errorResult(`offset ${offset} 超出文件行数`);
        }
        const end = offset - 1 + slice.length;
        const note = hasMore ? `\n[已截断：显示到第 ${end} 行]` : '';
        return { output: formatBody(slice, offset) + note };
      }
      const content = await readFile(absolute, 'utf8');
      const lines = content.split('\n');
      if (offset > lines.length) {
        return errorResult(`offset ${offset} 超出文件行数（共 ${lines.length} 行）`);
      }
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const end = offset - 1 + slice.length;
      const note = end < lines.length ? `\n[已截断：共 ${lines.length} 行，显示到第 ${end} 行]` : '';
      return { output: formatBody(slice, offset) + note };
    } catch (error) {
      return errorResult(`读取失败：${errorMessage(error)}`);
    }
  },
});
