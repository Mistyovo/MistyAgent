import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 工具输出落盘（opencode 风格）：TUI 工具块只预览前 TOOL_OUTPUT_PREVIEW_LINES 行，
 * 超出时把全量输出写到临时文件，截断提示行附文件路径。
 *
 * 落盘点在 core 的 tool 结果事件处理处（Session 转发 tool-call-completed 时），
 * 与既有 30k 字符截断同属 core 的 tool 结果处理层；UI 侧 reducer 保持纯函数不做 IO。
 * 事件里的 output 仍是全量（消息历史 / 模型所见不受影响），outputFile 仅供展示层引用。
 */

/** 工具块预览行数：输出超过此行数即落盘；MessageList 用同一常量做预览截断，两处不会漂移 */
export const TOOL_OUTPUT_PREVIEW_LINES = 3;

/** 旧文件保留时长：启动清理时删除 mtime 早于此的文件 */
const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 落盘目录：os.tmpdir()/misty-output；MISTY_OUTPUT_DIR 可覆盖（测试隔离 / 自定义位置） */
export function outputSpillDir(): string {
  return process.env.MISTY_OUTPUT_DIR ?? join(tmpdir(), 'misty-output');
}

let counter = 0;

/**
 * 输出行数超预览阈值时写 <dir>/<sessionKey>-<n>.log 并返回路径，否则返回 null。
 * 任何 IO 失败降级为 null（展示层退回无路径的截断提示），不影响 agent loop。
 */
export function spillToolOutput(output: string, sessionKey: string): string | null {
  if (output.split('\n').length <= TOOL_OUTPUT_PREVIEW_LINES) {
    return null;
  }
  try {
    const dir = outputSpillDir();
    mkdirSync(dir, { recursive: true });
    counter += 1;
    const safeKey = sessionKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const filePath = join(dir, `${safeKey}-${counter}.log`);
    writeFileSync(filePath, output, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

/** 启动时清理过期的落盘文件；目录不存在等 IO 失败静默忽略 */
export function cleanupSpilledOutputs(maxAgeMs: number = SPILL_MAX_AGE_MS): void {
  try {
    const dir = outputSpillDir();
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of readdirSync(dir)) {
      const filePath = join(dir, entry);
      const stat = statSync(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        rmSync(filePath, { force: true });
      }
    }
  } catch {
    // 目录不存在等场景无需处理
  }
}
