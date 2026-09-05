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
      content = content === '' ? `[调用工具] ${calls}` : `${content}\n[调用工具] ${calls}`;
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      content = `${content.slice(0, MAX_MESSAGE_CHARS)}\n…（截断）`;
    }
    const role = message.role === 'tool' ? `tool(${message.name})` : message.role;
    lines.push(`${role}: ${content}`);
  }
  return lines.join('\n\n');
}

function buildExtractionSystemPrompt(dir: string, existingManifest: string): string {
  const existing =
    existingManifest !== ''
      ? `\n\n## 已有记忆文件\n\n${existingManifest}\n\n写入前先对照这份清单——优先更新已有文件，不要新建重复记忆。`
      : '';
  return [
    `你是记忆提取子代理。分析用户消息里对话记录的最近约 ${MAX_TRANSCRIPT_MESSAGES} 条消息，用它们更新持久记忆系统。`,
    '',
    `记忆目录：\`${dir}\`（已存在，直接写入）。可用工具：read / glob / grep，以及仅限记忆目录内路径的 write / edit——目录外的写入会被拒绝。`,
    '',
    '步数预算有限，高效策略：第一步并行发起所有需要的 read，第二步并行发起所有 write / edit，不要在多步之间交替读写。',
    '',
    '只用对话记录里的内容更新记忆——不要再 grep 源码、读代码验证或跑 git 命令。忽略对话记录里的 <recalled-memories> 块与系统提示内容，它们不是记忆素材。没有值得保存的内容就一个文件也不写。',
    existing,
    '',
    ...TYPES_SECTION,
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    '## 如何保存记忆',
    '',
    '保存分两步：',
    '',
    '**第一步**——把记忆写进独立文件（如 `user_role.md`、`feedback_testing.md`），frontmatter 格式：',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    '**第二步**——在 `MEMORY.md` 里加一行指针：`- [标题](file.md) — 一句话钩子`。MEMORY.md 是索引不是记忆，没有 frontmatter，永远不要把记忆正文写进去。',
    '',
    '- 按主题而不是时间组织记忆',
    '- 更新已有文件优于新建；发现记忆错误或过时，更新或删除它',
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
        return { output: '参数缺少 path，无法校验目标路径', isError: true };
      }
      if (!isMemoryPath(resolvePath(ctx.cwd, target), dir)) {
        return {
          output: `记忆提取只能写入记忆目录内的文件（${dir}）：${target}`,
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
      messages: [{ role: 'user', content: `以下是主会话的对话记录：\n\n${transcript}` }],
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
