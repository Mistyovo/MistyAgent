import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath } from './fs-utils';

const inputSchema = z.object({
  path: z.string().describe('文件路径，相对 cwd 或绝对路径；父目录不存在时自动创建'),
  content: z.string().describe('要写入的完整内容（覆盖已有文件）'),
});

export const writeTool = defineTool({
  name: 'write',
  description: '创建或覆盖写入文件，父目录不存在时自动创建。大改动优先用 edit 做精确替换。',
  inputSchema,
  accesses: (input) => [{ kind: 'write', paths: [input.path] }],
  describeCall: (input) => `Write ${input.path}`,
  call: async (input, ctx) => {
    const absolute = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, absolute);
    try {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, input.content, 'utf8');
      return { output: `已写入 ${shown}（${input.content.length} 字符）` };
    } catch (error) {
      return errorResult(`写入失败：${errorMessage(error)}`);
    }
  },
});
