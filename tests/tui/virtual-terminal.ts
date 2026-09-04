import { EventEmitter } from 'node:events';

import { eastAsianWidth } from 'get-east-asian-width';

/**
 * 虚拟终端：模拟真实 TTY 的光标/擦除/自动换行语义，用于复现 ink 在非 debug
 * 模式下的渲染行为（ink-testing-library 的 debug 模式不走 eraseLines 路径）。
 *
 * widthMode:
 * - 'narrow'：歧义宽字符（box drawing ─、✓、… 等 East Asian Ambiguous）按 1 格，
 *   与 ink/string-width 的预算一致（Windows Terminal、UTF-8 conhost）
 * - 'legacy-cjk'：模拟中文区 cmd.exe 老式 conhost（GBK/点阵字体），Ambiguous 按 2 格
 */

export type WidthMode = 'narrow' | 'legacy-cjk';

type Cell = { ch: string; w: number } | 'cont' | null;

export class VirtualTerminal extends EventEmitter {
  readonly isTTY = true;

  private lines: Cell[][] = [[]];
  private cy = 0;
  private cx = 0;

  constructor(
    readonly columns = 120,
    readonly rows = 30,
    readonly widthMode: WidthMode = 'narrow',
  ) {
    super();
  }

  write(chunk: string): boolean {
    this.feed(chunk);
    return true;
  }

  /** 整个回滚缓冲区+可视区的文本（行尾空白已修剪；宽字符延续格不输出） */
  content(): string {
    return this.lines
      .map((line) =>
        line
          .map((cell) => {
            if (cell === 'cont') {
              return '';
            }
            return cell === null ? ' ' : cell.ch;
          })
          .join('')
          .trimEnd(),
      )
      .join('\n');
  }

  private newline(): void {
    this.cy += 1;
    this.cx = 0;
    while (this.cy >= this.lines.length) {
      this.lines.push([]);
    }
  }

  private blankRange(from: number, to: number): void {
    const line = this.lines[this.cy]!;
    for (let x = from; x < to && x < line.length; x += 1) {
      line[x] = null;
    }
    // 覆盖点落在一个宽字符的延续格上：把它的起始格也清掉
    if (from > 0) {
      const prev = line[from - 1];
      if (prev !== null && prev !== undefined && prev !== 'cont' && prev.w === 2) {
        line[from - 1] = null;
      }
    }
  }

  private putChar(ch: string, codePoint: number): void {
    const measured = eastAsianWidth(codePoint, {
      ambiguousAsWide: this.widthMode === 'legacy-cjk',
    });
    const w = Math.max(1, measured);
    // 终端的 deferred wrap：放不下就先换行
    if (this.cx + w > this.columns) {
      this.newline();
    }
    const line = this.lines[this.cy]!;
    while (line.length < this.cx) {
      line.push(null);
    }
    this.blankRange(this.cx, this.cx + w);
    line[this.cx] = { ch, w };
    if (w === 2) {
      line[this.cx + 1] = 'cont';
    }
    this.cx += w;
  }

  private csi(rawParams: string, final: string): void {
    const privateMarker = rawParams.startsWith('?');
    const nums = rawParams
      .replace(/^\?/, '')
      .split(';')
      .filter((p) => p !== '')
      .map((p) => Number.parseInt(p, 10));
    const n = nums[0] ?? 1;
    if (privateMarker) {
      return; // ?25l/h 光标显隐、?2026h/l 同步输出标记：忽略
    }
    switch (final) {
      case 'm':
        return; // SGR 颜色
      case 'A':
        this.cy = Math.max(0, this.cy - n);
        return;
      case 'B':
        this.cy += n;
        while (this.cy >= this.lines.length) {
          this.lines.push([]);
        }
        return;
      case 'C':
        this.cx = Math.min(this.columns, this.cx + n);
        return;
      case 'D':
        this.cx = Math.max(0, this.cx - n);
        return;
      case 'E':
        this.cy += n;
        this.cx = 0;
        while (this.cy >= this.lines.length) {
          this.lines.push([]);
        }
        return;
      case 'G':
      case '`':
        this.cx = Math.max(0, n - 1);
        return;
      case 'H':
      case 'f':
        this.cy = Math.max(0, (nums[0] ?? 1) - 1);
        this.cx = Math.max(0, (nums[1] ?? 1) - 1);
        while (this.cy >= this.lines.length) {
          this.lines.push([]);
        }
        return;
      case 'J':
        if (n === 2 || n === 3) {
          this.lines = [[]];
          this.cy = 0;
          this.cx = 0;
          return;
        }
        return;
      case 'K':
        if (n === 2) {
          this.lines[this.cy] = [];
          this.cx = 0;
          return;
        }
        if (n === 0) {
          this.blankRange(this.cx, this.lines[this.cy]!.length);
          return;
        }
        return;
      default:
        return;
    }
  }

  private feed(input: string): void {
    let index = 0;
    while (index < input.length) {
      const ch = input[index]!;
      if (ch === '\x1b') {
        // oxlint-disable-next-line no-control-regex -- 终端模拟器需要有意识地解析 ANSI 控制序列
        const match = /^\x1b\[([0-9;?]*)([A-Za-z`])/.exec(input.slice(index));
        if (match !== null) {
          this.csi(match[1] ?? '', match[2]!);
          index += match[0].length;
          continue;
        }
        index += 2; // 非 CSI 序列（本测试不产生），保守跳过
        continue;
      }
      if (ch === '\n') {
        this.newline();
        index += 1;
        continue;
      }
      if (ch === '\r') {
        this.cx = 0;
        index += 1;
        continue;
      }
      const codePoint = ch.codePointAt(0)!;
      const text = String.fromCodePoint(codePoint);
      index += text.length;
      this.putChar(text, codePoint);
    }
  }
}

/** ink App 以 readable/read() 模式消费 stdin；写入进缓冲，多次写入安全 */
export class FakeTtyStdin extends EventEmitter {
  readonly isTTY = true;
  private buffer = '';

  write(data: string): void {
    this.buffer += data;
    this.emit('readable');
  }

  read(): string | null {
    if (this.buffer === '') {
      return null;
    }
    const data = this.buffer;
    this.buffer = '';
    return data;
  }

  setRawMode(): void {}
  setEncoding(): void {}
  ref(): void {}
  unref(): void {}
  resume(): void {}
  pause(): void {}
}
