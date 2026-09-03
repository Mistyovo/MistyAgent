import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export function resolvePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}

/** 输出给模型的路径：相对 cwd 且统一为正斜杠 */
export function displayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  const shown = relative === '' ? '.' : relative;
  return shown.split(path.sep).join('/');
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

/**
 * 递归收集目录下的文件（跳过 .git / node_modules）。
 * 目录不可读时跳过而不是失败，与 ripgrep 的行为一致。
 */
export async function walkFiles(root: string, limit = 100_000): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await walk(full);
        }
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await walk(root);
  return files;
}

/** 前 8KB 内出现 NUL 字节即视为二进制 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  const buffer = await readFile(filePath);
  const head = buffer.subarray(0, 8192);
  return head.includes(0);
}

export interface StatResult {
  isFile: boolean;
  isDirectory: boolean;
  missing: boolean;
}

export async function statKind(filePath: string): Promise<StatResult> {
  try {
    const stats = await stat(filePath);
    return { isFile: stats.isFile(), isDirectory: stats.isDirectory(), missing: false };
  } catch {
    return { isFile: false, isDirectory: false, missing: true };
  }
}

export function truncate(text: string, max: number, note: string): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n${note}`;
}

export function errorResult(message: string): { output: string; isError: true } {
  return { output: message, isError: true };
}
