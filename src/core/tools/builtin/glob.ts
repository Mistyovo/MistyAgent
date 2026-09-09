import picomatch from 'picomatch';
import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath, statKind, walkFiles } from './fs-utils';

const MAX_RESULTS = 1000;

const inputSchema = z.object({
  pattern: z
    .string()
    .describe('Glob pattern, e.g. "src/**/*.ts"; * does not cross directories, ** does'),
  path: z
    .string()
    .optional()
    .describe('Search root, relative to cwd or absolute; defaults to cwd'),
});

export const globTool = defineTool({
  name: 'glob',
  description:
    'Find files by name pattern (the starting point for exploring a codebase: locate files first, then read / grep them). ' +
    'Returns paths relative to cwd (skipping .git / node_modules), ' +
    `up to ${MAX_RESULTS} results; * does not cross directories, ** does.`,
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => `Glob ${input.pattern}`,
  call: async (input, ctx) => {
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    const stats = await statKind(root);
    if (!stats.isDirectory) {
      return errorResult(`Directory not found: ${displayPath(ctx.cwd, root)}`);
    }
    let isMatch;
    try {
      isMatch = picomatch(input.pattern, { dot: true });
    } catch (error) {
      return errorResult(`Invalid glob pattern: ${errorMessage(error)}`);
    }
    const files = await walkFiles(root);
    const matched = files
      .filter((file) => isMatch(displayPath(root, file)))
      .map((file) => displayPath(ctx.cwd, file))
      .toSorted();
    if (matched.length === 0) {
      return { output: 'No matching files' };
    }
    const shown = matched.slice(0, MAX_RESULTS);
    const note =
      matched.length > MAX_RESULTS
        ? `\n[Too many results, truncated: ${matched.length} matches in total]`
        : '';
    return { output: shown.join('\n') + note };
  },
});
