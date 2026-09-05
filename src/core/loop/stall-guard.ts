export const STALL_THRESHOLD = 4;

export interface StallCall {
  name: string;
  /** JSON 解析后的工具参数；解析失败时调用方按非只读上报 */
  input: unknown;
  isReadOnly: boolean;
}

/** 输出内容去重键：FNV-1a 32 位，turn 级集合里避免囤积原始输出全文 */
function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * 零产出停滞检测（借鉴 muteki 的 idle-repeat/barren）：维护本 turn 已见
 * 输出内容集合，一步里全部调用只读且全部输出都已出现过即「barren」（零新
 * 信息）；连续 barren 达阈值时返回一条 steer 文本，每 turn 最多发一次。
 * 检测器是 turn 级的，由 runTurn 创建；doom-loop 已介入的步由调用方跳过，
 * 避免双重干预。
 */
export class StallGuard {
  private readonly seenOutputs = new Set<string>();
  private barrenStreak = 0;
  private steered = false;

  constructor(private readonly threshold: number = STALL_THRESHOLD) {}

  /** 记录一步的调用与输出；达到连续 barren 阈值时返回 steer 文本，否则 null */
  recordStep(calls: readonly StallCall[], outputs: readonly string[]): string | null {
    const barren =
      calls.length > 0 &&
      outputs.length > 0 &&
      calls.every((call) => call.isReadOnly) &&
      outputs.every((output) => this.seenOutputs.has(hashContent(output)));
    for (const output of outputs) {
      this.seenOutputs.add(hashContent(output));
    }
    if (!barren) {
      this.barrenStreak = 0;
      return null;
    }
    this.barrenStreak += 1;
    if (this.barrenStreak < this.threshold || this.steered) {
      return null;
    }
    this.steered = true;
    return (
      `连续 ${this.barrenStreak} 步没有获得任何新信息（均为重复读取已见内容）。` +
      '请停止重复读取：基于已经掌握的信息直接行动或给出结论；' +
      '若确实卡住，向用户说明卡点与需要的信息。'
    );
  }
}
