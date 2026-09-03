import { z } from 'zod';

export const todoItemSchema = z.object({
  content: z.string().min(1).describe('任务内容（已完成任务保持原文，不要改写）'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('任务状态'),
  activeForm: z.string().min(1).optional().describe('任务进行中时的展示文案（如「正在…」）'),
});

export type TodoItem = z.output<typeof todoItemSchema>;

export type TodoListener = (todos: TodoItem[]) => void;

/**
 * 校验全量替换的新列表（相对当前列表）：
 * - 同一时刻至多一个 in_progress
 * - 按位置对应、前后都为 done 的条目 content 不可变（已完成任务不许改写）
 * 返回错误消息表示校验失败；null 表示通过。
 */
export function validateTodos(next: TodoItem[], prev: TodoItem[]): string | null {
  const active = next.filter((todo) => todo.status === 'in_progress');
  if (active.length > 1) {
    return `同一时刻至多一个 in_progress 任务（收到 ${active.length} 个）`;
  }
  for (let index = 0; index < prev.length && index < next.length; index += 1) {
    const before = prev[index]!;
    const after = next[index]!;
    if (before.status === 'done' && after.status === 'done' && before.content !== after.content) {
      return `已完成的任务不能修改内容：「${before.content}」→「${after.content}」`;
    }
  }
  return null;
}

/**
 * 会话级 todo 内存存储：全量替换语义，变更时通知监听器（Session 转发为
 * todos-updated 事件）。监听器异常隔离，不影响 store 与其他监听器。
 */
export class TodoStore {
  private todos: TodoItem[] = [];
  private readonly listeners = new Set<TodoListener>();

  list(): TodoItem[] {
    return this.todos.map((todo) => ({ ...todo }));
  }

  onChange(listener: TodoListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 校验并全量替换；返回错误消息表示校验失败（store 保持不变） */
  replace(todos: TodoItem[]): string | null {
    const error = validateTodos(todos, this.todos);
    if (error !== null) {
      return error;
    }
    this.todos = todos.map((todo) => ({ ...todo }));
    this.emit();
    return null;
  }

  /** 清空（新会话用）；本就是空列表时不发通知 */
  clear(): void {
    if (this.todos.length === 0) {
      return;
    }
    this.todos = [];
    this.emit();
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // 监听器异常隔离
      }
    }
  }
}
