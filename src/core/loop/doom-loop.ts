export const DOOM_LOOP_THRESHOLD = 3;

/**
 * doom-loop 检测（借鉴 opencode processor 的 DOOM_LOOP）：
 * 跟踪最近一次通过 preflight 的工具调用签名（工具名 + 序列化参数），
 * 连续 threshold 次完全相同即判定为重复调用循环。检测器是 turn 级的，
 * 由 runTurn 创建、tool-scheduler 在权限放行前记录。
 */
export class DoomLoopDetector {
  private signature: string | null = null;
  private streak = 0;

  constructor(private readonly threshold: number = DOOM_LOOP_THRESHOLD) {}

  /** 记录一次调用；返回 true 表示连续相同调用达到阈值（疑似死循环） */
  record(name: string, serializedInput: string): boolean {
    const signature = `${name}\n${serializedInput}`;
    if (signature === this.signature) {
      this.streak += 1;
    } else {
      this.signature = signature;
      this.streak = 1;
    }
    return this.streak >= this.threshold;
  }
}
