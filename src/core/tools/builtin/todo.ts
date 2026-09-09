import { z } from 'zod';

import { todoItemSchema, type TodoStore } from '../../todos';
import { defineTool, type Tool } from '../tool';

const inputSchema = z.object({
  todos: z.array(todoItemSchema).describe('The complete task list after the replacement'),
});

/**
 * 会话级任务列表（对标 Claude Code TodoWrite）：全量替换语义。
 * 只改会话内存，不落盘、无系统副作用，因此按只读处理（不弹审批、可与只读调用并发）。
 */
export function createTodoTool(store: TodoStore): Tool {
  return defineTool({
    name: 'todo',
    description:
      'Update the session task list (this replaces the whole list, not an incremental edit). The list is visible to the user and should reflect real progress. ' +
      'For work expected to take more than about three steps, create the list up front and break the work into verifiable small steps. ' +
      'Keep exactly one item in_progress; when an item finishes, mark it done immediately and move the next one in. ' +
      'Leave already-done items untouched — do not rewrite their content.',
    inputSchema,
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) => `Todo (${input.todos.length} items)`,
    call: (input) => {
      const error = store.replace(input.todos);
      if (error !== null) {
        return Promise.resolve({ output: error, isError: true });
      }
      const active = input.todos.find((todo) => todo.status === 'in_progress');
      const suffix = active === undefined ? '' : `, in progress: ${active.content}`;
      return Promise.resolve({
        output: `Task list updated (${input.todos.length} items${suffix})`,
      });
    },
  });
}
