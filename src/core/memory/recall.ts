import { readFileSync } from 'node:fs';

import type { ChatProvider } from '#/provider/types';

import { getMemoryDir } from './paths';
import { formatMemoryManifest, scanMemoryFiles } from './store';

const MAX_SELECTED = 5;
/** 单条记忆读入上下文的字符上限 */
const MAX_MEMORY_CONTENT_CHARS = 4000;

export interface RelevantMemory {
  path: string;
  content: string;
  mtimeMs: number;
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will help MistyAgent (a CLI coding assistant) handle the user's request. You receive the user's request and a manifest of memory files (filename + summary).

Pick the filenames of the memories that will definitely help (at most ${MAX_SELECTED}) and output only a single JSON object: {"selected": ["filename", ...]}. Output nothing else.
- If you are unsure whether something helps, leave it out — fewer and better;
- If no memory is clearly useful, return an empty list;
- If a list of recently used tools is given, do not select usage references or API documentation for those tools (the assistant is already using them, and the usage is in the conversation); memories about pitfalls, warnings, and known issues with those tools are still worth selecting — they matter most exactly while the tool is in use.`;

/** 把 provider 流的 text-delta 拼成完整文本；error part 直接抛给外层容错 */
async function collectText(
  provider: ChatProvider,
  model: string,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let text = '';
  for await (const part of provider.generate({
    model,
    systemPrompt: SELECT_MEMORIES_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    maxTokens: 256,
    signal,
  })) {
    if (part.type === 'text-delta') {
      text += part.text;
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }
  return text;
}

/** 容错解析选择结果：提取首个 JSON 对象，文件名必须在清单内，任何失败返回 [] */
function parseSelectedFilenames(text: string, valid: ReadonlySet<string>): string[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const selected = (parsed as { selected?: unknown }).selected;
  if (!Array.isArray(selected)) {
    return [];
  }
  return selected
    .filter((f): f is string => typeof f === 'string' && valid.has(f))
    .slice(0, MAX_SELECTED);
}

/**
 * 按 query 召回相关记忆：扫描记忆头 → 让小模型从清单选最多 5 条 → 读入文件内容。
 * alreadySurfaced 在选取前过滤，把名额留给没展示过的记忆。
 * 任何异常或中断都返回 []，记忆召回永不阻断主流程。
 */
export async function findRelevantMemories(deps: {
  provider: ChatProvider;
  model: string;
  query: string;
  recentTools?: readonly string[];
  alreadySurfaced?: ReadonlySet<string>;
  signal?: AbortSignal;
  dir?: string;
}): Promise<RelevantMemory[]> {
  try {
    if (deps.signal?.aborted === true) {
      return [];
    }
    const memories = scanMemoryFiles(deps.dir ?? getMemoryDir()).filter(
      (m) => !(deps.alreadySurfaced?.has(m.filePath) ?? false),
    );
    if (memories.length === 0) {
      return [];
    }

    const toolsSection =
      deps.recentTools !== undefined && deps.recentTools.length > 0
        ? `\n\nRecently used tools: ${deps.recentTools.join(', ')}`
        : '';
    const text = await collectText(
      deps.provider,
      deps.model,
      `Query: ${deps.query}\n\nAvailable memories:\n${formatMemoryManifest(memories)}${toolsSection}`,
      deps.signal,
    );

    const byFilename = new Map(memories.map((m) => [m.filename, m]));
    const selected: RelevantMemory[] = [];
    for (const filename of parseSelectedFilenames(text, new Set(byFilename.keys()))) {
      const header = byFilename.get(filename)!;
      const content = readFileSync(header.filePath, 'utf8');
      selected.push({
        path: header.filePath,
        content:
          content.length > MAX_MEMORY_CONTENT_CHARS
            ? content.slice(0, MAX_MEMORY_CONTENT_CHARS)
            : content,
        mtimeMs: header.mtimeMs,
      });
    }
    return selected;
  } catch {
    return [];
  }
}
