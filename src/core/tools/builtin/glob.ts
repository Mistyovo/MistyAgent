import picomatch from 'picomatch';
import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath, statKind, walkFiles } from './fs-utils';

const MAX_RESULTS = 1000;

const inputSchema = z.object({
  pattern: z.string().describe('glob 模式，如 "src/**/*.ts"；* 不跨目录，** 跨目录'),
  path: z.string().optional().describe('搜索根目录，相对 cwd 或绝对路径，默认 cwd'),
});

export const globTool = defineTool({
  name: 'glob',
  description:
    '按文件名模式查找文件，返回相对 cwd 的路径列表（跳过 .git / node_modules）。' +
    `最多返回 ${MAX_RESULTS} 条。`,
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Glob ${input.pattern}`,
  call: async (input, ctx) => {
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const stats = await statKind(root);
    if (!stats.isDirectory) {
      return errorResult(`目录不存在：${displayPath(ctx.cwd, root)}`);
    }
    let isMatch;
    try {
      isMatch = picomatch(input.pattern, { dot: true });
    } catch (error) {
      return errorResult(`非法的 glob 模式：${errorMessage(error)}`);
    }
    const files = await walkFiles(root);
    const matched = files
      .filter((file) => isMatch(displayPath(root, file)))
      .map((file) => displayPath(ctx.cwd, file))
      .toSorted();
    if (matched.length === 0) {
      return { output: '没有匹配的文件' };
    }
    const shown = matched.slice(0, MAX_RESULTS);
    const note =
      matched.length > MAX_RESULTS
        ? `\n[结果过多已截断，共 ${matched.length} 个匹配]`
        : '';
    return { output: shown.join('\n') + note };
  },
});
