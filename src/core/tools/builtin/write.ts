import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { displayPath, errorResult, resolvePath, statKind } from './fs-utils';
import { hasRead, recordWritten, staleFileError } from './read-registry';

const inputSchema = z.object({
  path: z
    .string()
    .describe('File path, relative to cwd or absolute; missing parent directories are created'),
  content: z.string().describe('Full content to write (overwrites an existing file)'),
});

export const writeTool = defineTool({
  name: 'write',
  description:
    'Create a new file or overwrite a file in full; missing parent directories are created. ' +
    'Use this for new files. For targeted changes to a file you have already read, prefer edit — a whole-file rewrite is easy to carry unintended changes. ' +
    'Read an existing file before overwriting it so you know what you are replacing; a file changed on disk since you read it is refused and must be re-read.',
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
      const note =
        existed && !wasRead ? ' (note: overwrote an existing file not read in this session)' : '';
      return { output: `Wrote ${shown} (${input.content.length} characters)${note}` };
    } catch (error) {
      return errorResult(`Write failed: ${errorMessage(error)}`);
    }
  },
});
