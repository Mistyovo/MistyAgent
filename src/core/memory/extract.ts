import type { ChatProvider, Message } from '#/provider/types';

import { runTurn } from '../loop/run-turn';
import { createPermissionRuntime } from '../permission/pipeline';
import { editTool } from '../tools/builtin/edit';
import { resolvePath } from '../tools/builtin/fs-utils';
import { globTool } from '../tools/builtin/glob';
import { grepTool } from '../tools/builtin/grep';
import { readTool } from '../tools/builtin/read';
import { writeTool } from '../tools/builtin/write';
import type { Tool, ToolContext, ToolResult } from '../tools/tool';

import { ensureMemoryDir, getMemoryDir, isMemoryPath } from './paths';
import { formatMemoryManifest, scanMemoryFiles } from './store';
import { MEMORY_FRONTMATTER_EXAMPLE, TYPES_SECTION, WHAT_NOT_TO_SAVE_SECTION } from './types';

/** 提取只分析最近一段对话，与蓝本的 ~40 条对齐 */
const MAX_TRANSCRIPT_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 2000;
const MAX_STEPS = 8;

function serializeTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages.slice(-MAX_TRANSCRIPT_MESSAGES)) {
    let content = message.content;
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      const calls = message.toolCalls.map((c) => `${c.name}(${c.arguments})`).join('; ');
      content = content === '' ? `[tool calls] ${calls}` : `${content}\n[tool calls] ${calls}`;
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      content = `${content.slice(0, MAX_MESSAGE_CHARS)}\n…(truncated)`;
    }
    const role = message.role === 'tool' ? `tool(${message.name})` : message.role;
    lines.push(`${role}: ${content}`);
  }
  return lines.join('\n\n');
}

function buildExtractionSystemPrompt(dir: string, existingManifest: string): string {
  const existing =
    existingManifest !== ''
      ? `\n\n## Existing memory files\n\n${existingManifest}\n\nCheck this list before writing — prefer updating an existing file over creating a duplicate memory.`
      : '';
  return [
    `You are a memory extraction subagent. Analyze the roughly ${MAX_TRANSCRIPT_MESSAGES} most recent messages of the conversation transcript in the user message and use them to update the persistent memory system.`,
    '',
    `Memory directory: \`${dir}\` (already exists, write to it directly). Available tools: read / glob / grep, plus write / edit restricted to paths inside the memory directory — writes outside it are rejected.`,
    '',
    'Your step budget is limited, so work efficiently: in step one issue all the reads you need in parallel, in step two issue all the writes / edits in parallel. Do not alternate reads and writes across many steps.',
    '',
    'Update memory only from what the transcript contains — do not grep the source, read code to verify, or run git commands. Ignore the <recalled-memories> blocks and system prompt content inside the transcript; they are not memory material. If nothing is worth saving, write no files at all.',
    existing,
    '',
    ...TYPES_SECTION,
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## How to save a memory',
    '',
    'Saving takes two steps:',
    '',
    '**Step one** — write the memory into its own file (e.g. `user_role.md`, `feedback_testing.md`) with this frontmatter format:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    '**Step two** — add a one-line pointer to `MEMORY.md`: `- [Title](file.md) — one-line hook`. MEMORY.md is an index, not a memory: it has no frontmatter, and memory content must never go into it.',
    '',
    '- Organize memories by topic, not by time',
    '- Updating an existing file beats creating a new one; when a memory is wrong or outdated, update or delete it',
  ].join('\n');
}

/**
 * 包装 write/edit：同名同 schema，只在 call 里先解析目标路径——
 * 落在记忆目录内才放行，否则返回 isError（对象展开包装，只覆写 call）。
 */
function guardMemoryWrite(tool: Tool, dir: string): Tool {
  return {
    ...tool,
    call: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const target =
        typeof input === 'object' && input !== null
          ? (input as { path?: unknown }).path
          : undefined;
      if (typeof target !== 'string') {
        return { output: 'Argument is missing path, cannot validate the target', isError: true };
      }
      if (!isMemoryPath(resolvePath(ctx.cwd, target), dir)) {
        return {
          output: `Memory extraction may only write files inside the memory directory (${dir}): ${target}`,
          isError: true,
        };
      }
      return tool.call(input, ctx);
    },
  };
}

/**
 * 对话结束后的记忆提取：跑一个提取专用 runTurn，让子代理把值得记的内容
 * 写进记忆目录，最后对比前后扫描得出新写/更新的文件清单。
 * 任何异常返回 { written: [] }，永不抛错——提取失败不影响主会话。
 */
export async function runMemoryExtraction(deps: {
  provider: ChatProvider;
  model: string;
  messages: readonly Message[];
  cwd: string;
  signal?: AbortSignal;
  dir?: string;
}): Promise<{ written: string[] }> {
  const dir = deps.dir ?? getMemoryDir();
  try {
    ensureMemoryDir(dir);
    const before = new Map(scanMemoryFiles(dir).map((h) => [h.filePath, h.mtimeMs]));
    const transcript = serializeTranscript(deps.messages);
    if (transcript.trim() === '') {
      return { written: [] };
    }
    await runTurn({
      provider: deps.provider,
      model: deps.model,
      systemPrompt: buildExtractionSystemPrompt(dir, formatMemoryManifest(scanMemoryFiles(dir))),
      messages: [{ role: 'user', content: `Here is the transcript of the main session:\n\n${transcript}` }],
      tools: [
        readTool,
        globTool,
        grepTool,
        guardMemoryWrite(writeTool, dir),
        guardMemoryWrite(editTool, dir),
      ],
      cwd: deps.cwd,
      maxSteps: MAX_STEPS,
      signal: deps.signal ?? new AbortController().signal,
      dispatchEvent: () => {},
      permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd: deps.cwd }),
    });
    return {
      written: scanMemoryFiles(dir)
        .filter((h) => before.get(h.filePath) !== h.mtimeMs)
        .map((h) => h.filePath),
    };
  } catch {
    return { written: [] };
  }
}
