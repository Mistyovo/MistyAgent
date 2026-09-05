import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 记忆目录：~/.misty/memory */
export function getMemoryDir(): string {
  return path.join(homedir(), '.misty', 'memory');
}

export function getMemoryIndexPath(): string {
  return path.join(getMemoryDir(), 'MEMORY.md');
}

/** 幂等创建记忆目录；权限等问题静默容错——写入时的真实错误由 write 工具反馈 */
export function ensureMemoryDir(dir = getMemoryDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 提示词照常组装
  }
}

const normalizeForCompare = (p: string): string => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** 判断绝对路径是否位于记忆目录内；Windows 下大小写不敏感 */
export function isMemoryPath(absPath: string, dir = getMemoryDir()): boolean {
  const target = normalizeForCompare(absPath);
  const root = normalizeForCompare(dir);
  return target === root || target.startsWith(root + path.sep);
}
