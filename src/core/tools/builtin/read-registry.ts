import { stat } from 'node:fs/promises';

/**
 * 进程级文件读取登记表：read / write / edit 成功后记录 (mtimeMs, size)。
 * edit/write 落笔前比对当前 stat——不一致说明文件被外部改动（编辑器、bash 命令、
 * /rewind 回滚），强制模型重新 read 拿到真实内容再改，避免用陈旧认知覆盖新改动。
 */

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

const stamps = new Map<string, FileStamp>();

async function record(absPath: string): Promise<void> {
  try {
    const stats = await stat(absPath);
    stamps.set(absPath, { mtimeMs: stats.mtimeMs, size: stats.size });
  } catch {
    stamps.delete(absPath);
  }
}

/** read 成功后登记当前文件状态 */
export function recordRead(absPath: string): Promise<void> {
  return record(absPath);
}

/** write/edit 成功后登记落笔后的状态（同会话内后续修改无需重新 read） */
export function recordWritten(absPath: string): Promise<void> {
  return record(absPath);
}

export function hasRead(absPath: string): boolean {
  return stamps.has(absPath);
}

/**
 * 新鲜度校验：登记过且当前 stat 与登记不一致时返回错误结果，否则 null。
 * 未登记过（本进程没读过）不拦截——只防「用旧内容覆盖新改动」。
 */
export async function staleFileError(
  absPath: string,
  shown: string,
): Promise<{ output: string; isError: true } | null> {
  const stamp = stamps.get(absPath);
  if (stamp === undefined) {
    return null;
  }
  let stats;
  try {
    stats = await stat(absPath);
  } catch {
    return null;
  }
  if (stats.mtimeMs === stamp.mtimeMs && stats.size === stamp.size) {
    return null;
  }
  return {
    output:
      `文件自上次读取后已被修改（外部编辑、bash 命令或 /rewind 回滚）：${shown}。` +
      '当前内容与你掌握的版本不一致，请重新 read 后再修改。',
    isError: true,
  };
}

/** /clear 开新会话时清空登记 */
export function clearReadRegistry(): void {
  stamps.clear();
}
