import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { sanitizeCwd } from '../session/transcript';

/** 一次写前快照：path 为原始绝对路径；existed=false 表示写入前文件不存在（rewind 时删除） */
export interface CheckpointFileRecord {
  path: string;
  backupPath: string;
  existed: boolean;
}

export interface Checkpoint {
  id: number;
  createdAt: number;
  userText: string;
  files: CheckpointFileRecord[];
}

const USER_TEXT_MAX_CHARS = 60;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function checkpointsRootDir(homeDir: string = homedir()): string {
  return join(homeDir, '.misty', 'checkpoints');
}

export function checkpointDirFor(cwd: string, homeDir: string = homedir()): string {
  return join(checkpointsRootDir(homeDir), sanitizeCwd(cwd));
}

/** 备份文件名：checkpoint id（跨 turn 防碰撞）+ 绝对路径 sha1 + basename（可读性） */
function backupNameFor(checkpointId: number, absPath: string): string {
  const hash = createHash('sha1').update(absPath).digest('hex');
  return `${checkpointId}-${hash}-${basename(absPath)}`;
}

function loadManifest(manifestPath: string): Checkpoint[] {
  try {
    if (!existsSync(manifestPath)) {
      return [];
    }
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { checkpoints?: unknown };
    return Array.isArray(parsed.checkpoints) ? (parsed.checkpoints as Checkpoint[]) : [];
  } catch {
    // 清单损坏按空处理
    return [];
  }
}

/**
 * 文件改动 checkpoint 存储：每个用户 turn 一个 pending checkpoint，
 * 写类工具落盘前把目标文件原样快照进 backups/；turn 结束有记录则密封落盘。
 * 全部 IO 容错：快照/落盘失败只影响可回滚性，不阻断 agent loop。
 */
export class CheckpointStore {
  private readonly dir: string;
  private readonly backupsDir: string;
  private readonly manifestPath: string;
  private sealed: Checkpoint[];
  private pending: Checkpoint | null = null;

  constructor(
    readonly cwd: string,
    options?: { dir?: string },
  ) {
    this.dir = options?.dir ?? checkpointDirFor(cwd);
    this.backupsDir = join(this.dir, 'backups');
    this.manifestPath = join(this.dir, 'manifest.json');
    this.sealed = loadManifest(this.manifestPath);
  }

  beginTurn(userText: string): void {
    // 上一个未密封的 pending 先按 endTurn 规则收尾
    this.endTurn();
    const id = Math.max(0, ...this.sealed.map((checkpoint) => checkpoint.id)) + 1;
    this.pending = {
      id,
      createdAt: Date.now(),
      userText:
        userText.length > USER_TEXT_MAX_CHARS
          ? `${userText.slice(0, USER_TEXT_MAX_CHARS)}…`
          : userText,
      files: [],
    };
  }

  snapshotBeforeWrite(absPath: string): void {
    const pending = this.pending;
    // 不在 turn 内的写不入 checkpoint；同 turn 同路径只备第一次
    if (pending === null || pending.files.some((file) => file.path === absPath)) {
      return;
    }
    try {
      const backupPath = join(this.backupsDir, backupNameFor(pending.id, absPath));
      const existed = existsSync(absPath);
      if (existed) {
        mkdirSync(this.backupsDir, { recursive: true });
        copyFileSync(absPath, backupPath);
      }
      pending.files.push({ path: absPath, backupPath, existed });
    } catch {
      // 快照失败不阻断工具执行，本次改动不进 checkpoint
    }
  }

  endTurn(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === null || pending.files.length === 0) {
      return;
    }
    this.sealed.push(pending);
    this.persist();
  }

  /** sealed 按 id 倒序（最新在前） */
  list(): Checkpoint[] {
    return this.sealed.toSorted((left, right) => right.id - left.id);
  }

  /**
   * 从最新 sealed 往回恢复到 id（含 id），随后删除 id 及更新的记录与备份。
   * 单文件 IO 失败尽量继续，失败路径放进 failed 返回。
   */
  rewind(
    id: number,
  ): { restored: string[]; deleted: string[]; failed?: string[] } | { error: string } {
    if (!this.sealed.some((checkpoint) => checkpoint.id === id)) {
      return { error: `checkpoint #${id} 不存在` };
    }
    // 同一路径可能出现在多个 checkpoint：从新到旧还原，最终停在最早备份的内容
    const rewound = this.sealed
      .filter((checkpoint) => checkpoint.id >= id)
      .toSorted((left, right) => right.id - left.id);
    const restored: string[] = [];
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const checkpoint of rewound) {
      for (const file of checkpoint.files) {
        try {
          if (file.existed) {
            mkdirSync(dirname(file.path), { recursive: true });
            copyFileSync(file.backupPath, file.path);
            restored.push(file.path);
          } else {
            rmSync(file.path, { force: true });
            deleted.push(file.path);
          }
        } catch {
          failed.push(file.path);
        }
      }
    }
    this.sealed = this.sealed.filter((checkpoint) => checkpoint.id < id);
    for (const checkpoint of rewound) {
      for (const file of checkpoint.files) {
        try {
          rmSync(file.backupPath, { force: true });
        } catch {
          // 备份清理失败不影响回滚结果
        }
      }
    }
    this.persist();
    return {
      restored: [...new Set(restored)],
      deleted: [...new Set(deleted)],
      ...(failed.length > 0 ? { failed: [...new Set(failed)] } : {}),
    };
  }

  /** /clear 语义：清空全部记录与备份目录，落盘空清单 */
  reset(): void {
    this.sealed = [];
    this.pending = null;
    try {
      rmSync(this.backupsDir, { recursive: true, force: true });
    } catch {
      // 备份目录清理失败不阻断
    }
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.manifestPath, JSON.stringify({ checkpoints: this.sealed }), 'utf8');
    } catch {
      // 落盘失败仅丢失持久化，内存状态仍可用
    }
  }
}

/** 清理各项目超龄的 checkpoint 目录（以 manifest.json 的 mtime 为准）；容错不抛 */
export function cleanupCheckpoints(
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  homeDir: string = homedir(),
): void {
  try {
    const root = checkpointsRootDir(homeDir);
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      try {
        if (statSync(join(dir, 'manifest.json')).mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // 无 manifest 或 stat 竞争（目录被并发删除）的条目跳过
      }
    }
  } catch {
    // 根目录不存在等场景无需处理
  }
}
