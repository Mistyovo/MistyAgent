/**
 * 流式渲染工具（纯函数/纯类，不依赖 React）。
 * 借鉴 Claude Code 与 kimi-code 的 streaming-ui：完整行才上屏防抖动，
 * delta 更新经固定间隔节流后再触发 React 重渲染。
 */

export interface SplitLines {
  /** 到最后一个换行为止的完整部分（可安全上屏，不含末尾换行） */
  complete: string;
  /** 最后一个换行之后的不完整行 */
  rest: string;
}

/** 无换行时 complete 为空；以换行结尾时 rest 为空 */
export function completeLinesOnly(text: string): SplitLines {
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    return { complete: '', rest: text };
  }
  return {
    complete: text.slice(0, lastNewline),
    rest: text.slice(lastNewline + 1),
  };
}

export interface Throttled {
  /** 有新数据时调用：冷却窗口外立即 emit（leading），窗口内合并到窗口结束（trailing） */
  schedule(): void;
  /** 强制立刻 emit 掉挂起的合并更新（turn 边界处保证顺序） */
  flush(): void;
  /** 卸载时清理定时器，丢弃挂起更新 */
  cancel(): void;
}

export function createThrottledEmitter(emit: () => void, intervalMs: number): Throttled {
  let timer: NodeJS.Timeout | null = null;
  let pending = false;

  const onTick = (): void => {
    if (pending) {
      pending = false;
      emit();
      // trailing 后进入新冷却窗口，保证任何窗口内至多一次 emit
      timer = setTimeout(onTick, intervalMs);
      return;
    }
    timer = null;
  };

  return {
    schedule() {
      if (timer === null) {
        emit();
        timer = setTimeout(onTick, intervalMs);
        return;
      }
      pending = true;
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        pending = false;
        emit();
      }
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
    },
  };
}
