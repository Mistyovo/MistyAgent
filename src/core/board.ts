/**
 * 任务级共享证据板（对标 muteki 的黑板/死路机制，进程内存级 MVP）：
 * 同一会话的子代理把已验证的事实与已排除的方向写到同一块板上，
 * 后续子代理动手前先读板，避免重复探索、重复踩坑。/clear 开新会话时整体 reset。
 */

export type BoardEntryKind = 'fact' | 'deadend';

export interface BoardEntry {
  kind: BoardEntryKind;
  text: string;
  /** 条目来源（如 Agent(explore)），渲染时附在文末 */
  source: string;
  createdAt: number;
}

const DEFAULT_MAX_ENTRIES = 200;
/** 收割单条内容的长度上限：标记行只应承载一行结论 */
const HARVEST_TEXT_MAX = 200;

/** 去重键：trim + 折叠空白 + 小写，同 kind 下语义相同的文本只保留一条 */
function normalize(text: string): string {
  return text.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

/** 展示文本：单行化（折叠空白），保留原大小写 */
function singleLine(text: string): string {
  return text.trim().replaceAll(/\s+/g, ' ');
}

export class TaskBoard {
  private readonly maxEntries: number;
  private items: BoardEntry[] = [];
  private keys = new Set<string>();

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  add(kind: BoardEntryKind, text: string, source: string): void {
    const key = `${kind}:${normalize(text)}`;
    if (key === `${kind}:` || this.keys.has(key)) {
      return;
    }
    this.keys.add(key);
    this.items.push({ kind, text: singleLine(text), source, createdAt: Date.now() });
    // 容量超出丢最旧（同步摘除其去重键，避免旧条目永久占位）
    while (this.items.length > this.maxEntries) {
      const dropped = this.items.shift()!;
      this.keys.delete(`${dropped.kind}:${normalize(dropped.text)}`);
    }
  }

  entries(): readonly BoardEntry[] {
    return [...this.items];
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  render(): string {
    const section = (title: string, kind: BoardEntryKind): string[] => {
      const lines = this.items
        .filter((entry) => entry.kind === kind)
        .map((entry) => `- ${entry.text}（${entry.source}）`);
      return [title, ...(lines.length > 0 ? lines : ['（暂无）'])];
    };
    return [
      ...section('已确认的事实：', 'fact'),
      '',
      ...section('已排除的方向（不要重复尝试）：', 'deadend'),
    ].join('\n');
  }

  reset(): void {
    this.items = [];
    this.keys.clear();
  }
}

/** 收割标记行：行首可选空白 + VERIFIED_FACT:/DEADEND: + 非空内容（\s*$ 兼容 CRLF 行尾） */
const MARKER_PATTERN = /^\s*(VERIFIED_FACT|DEADEND)\s*:\s*(.*?)\s*$/;

/** 从子代理结论文本中收割证据板条目；忽略空内容行，每条截断到 HARVEST_TEXT_MAX */
export function harvestBoardEntries(text: string): Array<{ kind: BoardEntryKind; text: string }> {
  const harvested: Array<{ kind: BoardEntryKind; text: string }> = [];
  for (const line of text.split('\n')) {
    const match = MARKER_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const content = match[2]!.trim();
    if (content === '') {
      continue;
    }
    harvested.push({
      kind: match[1] === 'VERIFIED_FACT' ? 'fact' : 'deadend',
      text: content.slice(0, HARVEST_TEXT_MAX),
    });
  }
  return harvested;
}
