import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath, statKind } from './fs-utils';
import { hasRead, recordWritten, staleFileError } from './read-registry';

const inputSchema = z.object({
  path: z.string().describe('文件路径，相对 cwd 或绝对路径；父目录不存在时自动创建'),
  content: z.string().describe('要写入的完整内容（覆盖已有文件）'),
});

export const writeTool = defineTool({
  name: 'write',
  description:
    '创建新文件或整文件覆盖写入，父目录不存在时自动创建。' +
    '新建文件用本工具；已读过的文件做局部修改优先用 edit 精确替换，整文件重写容易带入意外改动。' +
    '覆盖已存在的文件前建议先 read 确认原内容；文件被外部改动后会拒绝写入，需重新 read。',
  inputSchema,
  accesses: (input) => [{ kind: 'write', paths: [input.path] }],
  describeCall: (input) => `Write ${input.path}`,
  call: async (input, ctx) => {
    const absolute = resolvePath(ctx.cwd, input.path);
    const shown = displayPath(ctx.cwd, absolute);
    const existed = (await statKind(absolute)).isFile;
    const wasRead = hasRead(absolute);
    if (existed) {
      const stale = await staleFileError(absolute, shown);
      if (stale !== null) {
        return stale;
      }
    }
    try {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, input.content, 'utf8');
      await recordWritten(absolute);
      const note = existed && !wasRead ? '；注意：覆盖了本会话未读取过的已有文件' : '';
      return { output: `已写入 ${shown}（${input.content.length} 字符）${note}` };
    } catch (error) {
      return errorResult(`写入失败：${errorMessage(error)}`);
    }
  },
});
