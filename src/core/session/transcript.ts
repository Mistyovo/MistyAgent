import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { Message } from '#/provider/types';

import pkg from '../../../package.json';

export const MISTY_VERSION: string = pkg.version;

export type TranscriptEntryType = 'user' | 'assistant' | 'tool' | 'meta';

/** JSONL transcript 的一行；uuid/parentUuid 构成追加链 */
export interface TranscriptEntry {
  uuid: string;
  parentUuid: string | null;
  type: TranscriptEntryType;
  timestamp: string;
  message: unknown;
}

/** meta 行内容：记录会话环境（model、权限模式、版本号） */
export interface SessionMeta {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: string;
  version: string;
}

/** 压缩检查点 meta 行内容：标记此前历史已被压缩，resume 从检查点之后的摘要恢复 */
export interface CompactCheckpointMeta {
  kind: 'compact-checkpoint';
  beforeCount: number;
  afterCount: number;
  beforeTokens: number;
  afterTokens: number;
}

export function isCompactCheckpoint(entry: TranscriptEntry): boolean {
  if (entry.type !== 'meta') {
    return false;
  }
  const message = entry.message as { kind?: unknown } | null;
  return typeof message === 'object' && message !== null && message.kind === 'compact-checkpoint';
}

/** 盘符冒号与路径分隔符统一替换为 -，作为项目目录名 */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[:/\\]/g, '-');
}

export function transcriptDirFor(cwd: string, homeDir: string = homedir()): string {
  return join(homeDir, '.misty', 'projects', sanitizeCwd(cwd));
}

/** readLastUuid 的尾部首窗：末行通常不足 1KB，找不到时窗口翻倍直至覆盖全文件 */
const TAIL_WINDOW_INITIAL_BYTES = 64 * 1024;

function lastUuidIn(text: string): string | null {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (line === '') {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { uuid?: unknown };
      if (typeof parsed.uuid === 'string') {
        return parsed.uuid;
      }
    } catch {
      // 损坏行（含窗口截断的半行）继续向上找
    }
  }
  return null;
}

/** 从文件尾部倒读最后一个 uuid，避免整文件加载 */
function readLastUuid(filePath: string): string | null {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    let window = TAIL_WINDOW_INITIAL_BYTES;
    for (;;) {
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const uuid = lastUuidIn(buffer.toString('utf8'));
      if (uuid !== null || length === size) {
        return uuid;
      }
      window *= 2;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * transcript 追加器：同步写盘保证顺序，resume 时从已有文件尾部续 uuid 链。
 * 消息体很小，同步 append 的阻塞可忽略。
 */
export class TranscriptWriter {
  private lastUuid: string | null;

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.lastUuid = existsSync(filePath) ? readLastUuid(filePath) : null;
  }

  get tailUuid(): string | null {
    return this.lastUuid;
  }

  append(type: TranscriptEntryType, message: unknown): TranscriptEntry {
    const entry: TranscriptEntry = {
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      type,
      timestamp: new Date().toISOString(),
      message,
    };
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
    this.lastUuid = entry.uuid;
    return entry;
  }

  /** 历史消息（user/assistant/tool）落盘；system 消息不进历史 */
  appendMessage(message: Message): TranscriptEntry {
    if (message.role === 'system') {
      throw new Error('system 消息不应写入 transcript');
    }
    return this.append(message.role, message);
  }
}

/** 逐行解析 JSONL；损坏行跳过，文件不存在返回空 */
export function loadTranscript(filePath: string): TranscriptEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as TranscriptEntry;
      if (typeof parsed.uuid === 'string' && typeof parsed.type === 'string') {
        entries.push(parsed);
      }
    } catch {
      // 损坏行跳过
    }
  }
  return entries;
}

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  /** 首条用户消息摘要（压成单行、截断），没有则为空串 */
  summary: string;
}

const SUMMARY_MAX_CHARS = 80;
/** 摘要只读文件头部：首条 user 行前只有很短的 meta 行；窗口截断的半行 JSON.parse 必失败被跳过 */
const SUMMARY_HEAD_BYTES = 8 * 1024;

function readHead(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const length = Math.min(fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function firstUserSummary(filePath: string): string {
  for (const line of readHead(filePath, SUMMARY_HEAD_BYTES).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    let entry: { type?: unknown; message?: unknown };
    try {
      entry = JSON.parse(trimmed) as { type?: unknown; message?: unknown };
    } catch {
      continue;
    }
    if (entry.type !== 'user') {
      continue;
    }
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string') {
      const oneLine = content.replace(/\s+/g, ' ').trim();
      return oneLine.length > SUMMARY_MAX_CHARS
        ? `${oneLine.slice(0, SUMMARY_MAX_CHARS)}…`
        : oneLine;
    }
  }
  return '';
}

/** 列出当前目录的持久化会话，按 mtime 倒序 */
export function listSessions(cwd: string, homeDir: string = homedir()): SessionSummary[] {
  const dir = transcriptDirFor(cwd, homeDir);
  if (!existsSync(dir)) {
    return [];
  }
  const sessions: SessionSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const filePath = join(dir, name);
    try {
      sessions.push({
        sessionId: basename(name, '.jsonl'),
        filePath,
        mtimeMs: statSync(filePath).mtimeMs,
        summary: firstUserSummary(filePath),
      });
    } catch {
      // stat 竞争失败（文件被并发删除）跳过
    }
  }
  return sessions.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

export interface ResumedSession {
  sessionId: string;
  filePath: string;
  /** 从 transcript 重建的消息历史（meta 行跳过；最后一个压缩检查点之前的历史丢弃） */
  messages: Message[];
}

function isHistoryMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && 'role' in value;
}

export function resumeSession(filePath: string): ResumedSession {
  if (!existsSync(filePath)) {
    throw new Error(`会话文件不存在：${filePath}`);
  }
  const entries = loadTranscript(filePath);
  // 最后一个压缩检查点之后才是有效历史，之前的原始历史已被压缩掉
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isCompactCheckpoint(entries[index]!)) {
      start = index + 1;
      break;
    }
  }
  const messages: Message[] = [];
  for (const entry of entries.slice(start)) {
    if (entry.type === 'meta' || !isHistoryMessage(entry.message)) {
      continue;
    }
    messages.push(entry.message);
  }
  return { sessionId: basename(filePath, '.jsonl'), filePath, messages };
}
