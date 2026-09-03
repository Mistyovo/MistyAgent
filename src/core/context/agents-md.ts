import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const AGENTS_MD_SEPARATOR = '\n\n--- project-doc ---\n\n';
/** 拼接后文档内容的总字节上限（不含分隔符） */
export const PROJECT_DOC_MAX_BYTES = 32 * 1024;

/** 从 cwd 向上找含 .git 的目录作为 project root；找不到则以 cwd 自身为 root */
export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
}

/**
 * 收集 project root → cwd 路径上每层目录的 AGENTS.md，按 root→cwd 顺序拼接。
 * 总字节超出 32KB 时截断（尾部 UTF-8 残片由 Node 替换为 U+FFFD）。
 */
export function collectAgentsDocs(cwd: string): string {
  const root = findProjectRoot(cwd);
  const chain: string[] = [];
  let dir = resolve(cwd);
  while (true) {
    chain.unshift(dir);
    if (dir === root) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  const docs: string[] = [];
  let remaining = PROJECT_DOC_MAX_BYTES;
  for (const current of chain) {
    if (remaining <= 0) {
      break;
    }
    const filePath = join(current, 'AGENTS.md');
    if (!existsSync(filePath)) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > remaining) {
      content = Buffer.from(content, 'utf8').subarray(0, remaining).toString('utf8');
    }
    remaining -= Buffer.byteLength(content, 'utf8');
    docs.push(content);
  }
  return docs.join(AGENTS_MD_SEPARATOR);
}
