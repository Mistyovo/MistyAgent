import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, isBinaryFile, resolvePath, statKind } from './fs-utils';

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

const inputSchema = z.object({
  path: z.string().describe('文件路径，相对 cwd 或绝对路径'),
  offset: z.number().int().min(1).optional().describe('起始行号（1 起），默认 1'),
  limit: z.number().int().min(1).optional().describe(`最多读取的行数，默认 ${MAX_LINES}`),
});

export const readTool = defineTool({
  name: 'read',
  description:
    '读取文本文件内容，输出带行号（<行号>\\t<内容>）。' +
    `默认最多 ${MAX_LINES} 行，超长行在 ${MAX_LINE_LENGTH} 字符处截断。` +
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
    try {
      if (await isBinaryFile(absolute)) {
        return errorResult(`文件不是文本文件（检测到二进制内容）：${shown}`);
      }
      const content = await readFile(absolute, 'utf8');
      const lines = content.split('\n');
      const offset = input.offset ?? 1;
      if (offset > lines.length) {
        return errorResult(`offset ${offset} 超出文件行数（共 ${lines.length} 行）`);
      }
      const limit = input.limit ?? MAX_LINES;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice
        .map((line, index) => {
          const truncated =
            line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
          return `${offset + index}\t${truncated}`;
        })
        .join('\n');
      const end = offset - 1 + slice.length;
      const note = end < lines.length ? `\n[已截断：共 ${lines.length} 行，显示到第 ${end} 行]` : '';
      return { output: body + note };
    } catch (error) {
      return errorResult(`读取失败：${errorMessage(error)}`);
    }
  },
});
