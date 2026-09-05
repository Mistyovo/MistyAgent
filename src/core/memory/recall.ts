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

const SELECT_MEMORIES_SYSTEM_PROMPT = `你在为 MistyAgent（CLI 编码助手）挑选处理用户请求时用得上的记忆。你会收到用户的请求和一份记忆文件清单（文件名 + 简介）。

从清单里选出确定会有帮助的记忆文件名（最多 ${MAX_SELECTED} 条），只输出一个 JSON 对象：{"selected": ["文件名", ...]}，不要输出任何其他内容。
- 拿不准有没有用就不要选，宁缺毋滥；
- 没有明显有用的记忆就返回空列表；
- 如果给出了最近使用的工具列表，不要选那些工具的用法参考或 API 文档类记忆（助手正在用它们，对话里已有用法）；但关于这些工具的坑、警告、已知问题的记忆仍要选——正在使用时恰恰最需要它们。`;

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
        ? `\n\n最近使用的工具：${deps.recentTools.join(', ')}`
        : '';
    const text = await collectText(
      deps.provider,
      deps.model,
      `Query: ${deps.query}\n\n可用记忆：\n${formatMemoryManifest(memories)}${toolsSection}`,
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
