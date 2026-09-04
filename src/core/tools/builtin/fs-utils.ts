import { open, readdir, stat } from 'node:fs/promises';
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
 * 递归枚举目录下的文件（跳过 .git / node_modules），边遍历边产出。
 * 消费者 break 时遍历随之终止，不必付全树遍历的代价。
 * 目录不可读时跳过而不是失败，与 ripgrep 的行为一致。
 */
export async function* walkFilesStream(
  root: string,
  limit = 100_000,
): AsyncGenerator<string> {
  let count = 0;
  async function* walk(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= limit) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          yield* walk(full);
        }
      } else if (entry.isFile()) {
        count += 1;
        yield full;
      }
    }
  }
  yield* walk(root);
}

/** 收集式包装：全量遍历后返回列表（glob 等需要全量+排序的消费者使用） */
export async function walkFiles(root: string, limit = 100_000): Promise<string[]> {
  const files: string[] = [];
  for await (const file of walkFilesStream(root, limit)) {
    files.push(file);
  }
  return files;
}

/** 前 8KB 内出现 NUL 字节即视为二进制；只定位读头部，不整文件加载 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export interface StatResult {
  isFile: boolean;
  isDirectory: boolean;
  missing: boolean;
  /** 字节数；missing 时为 0 */
  size: number;
}

export async function statKind(filePath: string): Promise<StatResult> {
  try {
    const stats = await stat(filePath);
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      missing: false,
      size: stats.size,
    };
  } catch {
    return { isFile: false, isDirectory: false, missing: true, size: 0 };
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
