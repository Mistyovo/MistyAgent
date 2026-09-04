import { readFile } from 'node:fs/promises';
import path from 'node:path';

import picomatch from 'picomatch';
import { z } from 'zod';

import { defineTool } from '../tool';

import {
  displayPath,
  errorResult,
  isBinaryFile,
  resolvePath,
  statKind,
  walkFilesStream,
} from './fs-utils';

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 500;

const inputSchema = z.object({
  pattern: z.string().describe('正则表达式（JS 语法）'),
  path: z.string().optional().describe('搜索根目录，相对 cwd 或绝对路径，默认 cwd'),
  include: z.string().optional().describe('文件名 glob 过滤，如 "*.ts"，相对搜索根目录匹配'),
});

export const grepTool = defineTool({
  name: 'grep',
  description:
    '在文件内容中搜索正则匹配，输出 <path>:<行号>:<内容>（跳过 .git / node_modules 与二进制文件）。' +
    `最多返回 ${MAX_MATCHES} 条。`,
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Grep /${input.pattern}/`,
  call: async (input, ctx) => {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch {
      return errorResult(`非法的正则表达式：${input.pattern}`);
    }
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const stats = await statKind(root);
    if (!stats.isDirectory) {
      return errorResult(`目录不存在：${displayPath(ctx.cwd, root)}`);
    }
    const include = input.include;
    const includeMatch = include !== undefined ? picomatch(include, { dot: true }) : undefined;
    // 与 ripgrep --glob 一致：不含 / 的模式按文件名匹配，否则按相对路径匹配
    const includeHits = (file: string, relativeToRoot: string): boolean => {
      if (includeMatch === undefined || include === undefined) {
        return true;
      }
      return include.includes('/')
        ? includeMatch(relativeToRoot)
        : includeMatch(path.basename(file));
    };

    const matches: string[] = [];
    let truncated = false;
    // 流式消费：命中上限即 break，遍历随之终止，不付全树遍历的代价
    for await (const file of walkFilesStream(root)) {
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      const relativeToRoot = displayPath(root, file);
      if (!includeHits(file, relativeToRoot)) {
        continue;
      }
      if (await isBinaryFile(file)) {
        continue;
      }
      const content = await readFile(file, 'utf8');
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!regex.test(line)) {
          continue;
        }
        const shown =
          line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
        matches.push(`${displayPath(ctx.cwd, file)}:${index + 1}:${shown}`);
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
      }
    }
    if (matches.length === 0) {
      return { output: '没有匹配的内容' };
    }
    const note = truncated ? `\n[匹配过多已截断，仅显示前 ${MAX_MATCHES} 条]` : '';
    return { output: matches.join('\n') + note };
  },
});
