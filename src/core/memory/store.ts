import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getMemoryDir } from './paths';
import { type MemoryType, parseMemoryType } from './types';

export const MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const MAX_INDEX_LINES = 200;
/** 约 125 字符/行 × 200 行；防单行过长的索引绕过行数上限 */
export const MAX_INDEX_BYTES = 25_000;

export interface IndexTruncation {
  content: string;
  wasTruncated: boolean;
}

/**
 * 把 MEMORY.md 内容截到行数与体积双上限之内，截断时末尾附警告说明触发哪个上限。
 * 先行截（保留自然边界），再在上限前最后一个换行处做体积截，避免切断行。
 */
export function truncateIndexContent(raw: string): IndexTruncation {
  const trimmed = raw.trim();
  const lines = trimmed.split('\n');
  const wasLineTruncated = lines.length > MAX_INDEX_LINES;
  // 体积判定用原始大小：单行过长正是体积上限要防的情形，按行截后的大小会低估
  const wasByteTruncated = trimmed.length > MAX_INDEX_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, wasTruncated: false };
  }

  let truncated = wasLineTruncated ? lines.slice(0, MAX_INDEX_LINES).join('\n') : trimmed;
  if (truncated.length > MAX_INDEX_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_INDEX_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_INDEX_BYTES);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `体积达 ${trimmed.length} 字符（上限 ${MAX_INDEX_BYTES}）——索引条目过长`
      : wasLineTruncated && !wasByteTruncated
        ? `行数达 ${lines.length} 行（上限 ${MAX_INDEX_LINES}）`
        : `行数达 ${lines.length} 行、体积达 ${trimmed.length} 字符`;

  return {
    content:
      truncated +
      `\n\n> 警告：MEMORY.md ${reason}，只加载了部分内容。` +
      '索引条目保持一行（约 200 字符以内），细节挪进主题文件。',
    wasTruncated: true,
  };
}

/** 读 MEMORY.md 索引原文；不存在或不可读返回 null */
export function readMemoryIndex(dir = getMemoryDir()): string | null {
  try {
    return readFileSync(join(dir, MEMORY_INDEX_FILENAME), 'utf8');
  } catch {
    return null;
  }
}

export interface MemoryHeader {
  filename: string;
  filePath: string;
  name: string;
  description: string;
  type?: MemoryType | undefined;
  mtimeMs: number;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 极简 frontmatter 解析（与 subagents.ts 同思路，不引 yaml 依赖）：
 * 只认 `key: value` 标量；文件不以 --- frontmatter 开头或缺 description 返回 null。
 */
function parseMemoryFrontmatter(
  content: string,
): { name: string | undefined; description: string; type: MemoryType | undefined } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match === null) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const rawLine of match[1]!.split('\n')) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(rawLine.replace(/\r$/, ''));
    if (pair !== null && pair[2] !== undefined && pair[2].trim() !== '') {
      fields[pair[1]!] = unquote(pair[2].trim());
    }
  }
  const description = fields['description'];
  if (description === undefined) {
    return null;
  }
  return { name: fields['name'], description, type: parseMemoryType(fields['type']) };
}

/**
 * 扫描记忆目录下的 *.md 主题文件（排除 MEMORY.md 索引），解析 frontmatter，
 * 按 mtimeMs 倒序。目录不可读返回 []；单个坏文件静默跳过。
 */
export function scanMemoryFiles(dir = getMemoryDir()): MemoryHeader[] {
  let filenames: string[];
  try {
    filenames = readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.md') && entry.name !== MEMORY_INDEX_FILENAME,
      )
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const headers: MemoryHeader[] = [];
  for (const filename of filenames) {
    try {
      const filePath = join(dir, filename);
      const parsed = parseMemoryFrontmatter(readFileSync(filePath, 'utf8'));
      if (parsed === null) {
        continue;
      }
      const header: MemoryHeader = {
        filename,
        filePath,
        name: parsed.name ?? filename,
        description: parsed.description,
        mtimeMs: statSync(filePath).mtimeMs,
      };
      if (parsed.type !== undefined) {
        header.type = parsed.type;
      }
      headers.push(header);
    } catch {
      // 坏文件静默跳过
    }
  }
  return headers.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 记忆清单：每行 `filename — description`，供召回选择与提取提示使用 */
export function formatMemoryManifest(headers: readonly MemoryHeader[]): string {
  return headers.map((header) => `${header.filename} — ${header.description}`).join('\n');
}
