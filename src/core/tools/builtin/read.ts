import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, isBinaryFile, resolvePath, statKind } from './fs-utils';
import { recordRead } from './read-registry';

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const inputSchema = z.object({
  path: z.string().describe('File path, relative to cwd or absolute'),
  offset: z.number().int().min(1).optional().describe('First line to read (1-based), default 1'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum number of lines to read, default ${MAX_LINES}`),
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
    'Read a text file, returning line-numbered output (<line>\\t<content>); those line numbers feed directly into a later edit and into citations in your conclusion. ' +
    `Reads at most ${MAX_LINES} lines by default and truncates over-long lines at ${MAX_LINE_LENGTH} characters. ` +
    `For large files (over ${MAX_FILE_SIZE / 1024 / 1024}MB) use offset/limit to read in segments, continuing where the output says it stopped. ` +
    'Binary files and directories cannot be read.',
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Read ${input.path}`,
  call: async (input, ctx) => {
    const absolute = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, absolute);
    const stats = await statKind(absolute);
    if (stats.missing) {
      return errorResult(`File not found: ${shown}`);
    }
    if (stats.isDirectory) {
      return errorResult(`Path is a directory, not a file: ${shown}`);
    }
    const oversized = stats.size > MAX_FILE_SIZE;
    const segmented = input.offset !== undefined || input.limit !== undefined;
    if (oversized && !segmented) {
      return errorResult(
        `File is too large (${(stats.size / 1024 / 1024).toFixed(1)}MB), over the ` +
          `${MAX_FILE_SIZE / 1024 / 1024}MB limit; read it in segments with offset/limit: ${shown}`,
      );
    }
    try {
      if (await isBinaryFile(absolute)) {
        return errorResult(`Not a text file (binary content detected): ${shown}`);
      }
      const offset = input.offset ?? 1;
      const limit = input.limit ?? MAX_LINES;
      if (oversized) {
        const { lines: slice, hasMore } = await readLineRange(absolute, offset, limit);
        if (slice.length === 0) {
          return errorResult(`offset ${offset} is past the end of the file`);
        }
        const end = offset - 1 + slice.length;
        const note = hasMore ? `\n[Truncated: shown through line ${end}]` : '';
        await recordRead(absolute);
        return { output: formatBody(slice, offset) + note };
      }
      const content = await readFile(absolute, 'utf8');
      const lines = content.split('\n');
      if (offset > lines.length) {
        return errorResult(`offset ${offset} is past the end of the file (${lines.length} lines)`);
      }
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const end = offset - 1 + slice.length;
      const note =
        end < lines.length
          ? `\n[Truncated: ${lines.length} lines total, shown through line ${end}]`
          : '';
      await recordRead(absolute);
      return { output: formatBody(slice, offset) + note };
    } catch (error) {
      return errorResult(`Read failed: ${errorMessage(error)}`);
    }
  },
});
