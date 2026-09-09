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
  pattern: z.string().describe('Regular expression (JavaScript syntax)'),
  path: z
    .string()
    .optional()
    .describe('Search root, relative to cwd or absolute; defaults to cwd'),
  include: z
    .string()
    .optional()
    .describe('Filename glob filter, e.g. "*.ts", matched relative to the search root'),
});

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents for a regular expression, returning <path>:<line>:<content> (skipping .git / node_modules and binary files). ' +
    `Returns at most ${MAX_MATCHES} matches. Search for a known symbol name or error string directly; ` +
    'narrow the file type with include (e.g. "*.ts") to cut noise sharply.',
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Grep /${input.pattern}/`,
  call: async (input, ctx) => {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch {
      return errorResult(`Invalid regular expression: ${input.pattern}`);
    }
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const stats = await statKind(root);
    if (!stats.isDirectory) {
      return errorResult(`Directory not found: ${displayPath(ctx.cwd, root)}`);
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
      return { output: 'No matches' };
    }
    const note = truncated
      ? `\n[Too many matches, truncated: showing the first ${MAX_MATCHES}]`
      : '';
    return { output: matches.join('\n') + note };
  },
});
