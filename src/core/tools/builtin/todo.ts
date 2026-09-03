import { z } from 'zod';

import { todoItemSchema, type TodoStore } from '../../todos';
import { defineTool, type Tool } from '../tool';

const inputSchema = z.object({
  todos: z.array(todoItemSchema).describe('全量替换后的完整任务列表'),
});

/**
 * 会话级任务列表（对标 Claude Code TodoWrite）：全量替换语义。
 * 只改会话内存，不落盘、无系统副作用，因此按只读处理（不弹审批、可与只读调用并发）。
 */
export function createTodoTool(store: TodoStore): Tool {
  return defineTool({
    name: 'todo',
    description:
      '更新会话级任务列表（全量替换整个列表，不是增量修改）。' +
      '多步骤任务开始时建立列表，进行中保持恰好一个 in_progress，完成一项标为 done。' +
      '已 done 的任务保持原样，不要修改其内容。',
    inputSchema,
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: (input) => `Todo ${input.todos.length} 项任务`,
    call: (input) => {
      const error = store.replace(input.todos);
      if (error !== null) {
        return Promise.resolve({ output: error, isError: true });
      }
      const active = input.todos.find((todo) => todo.status === 'in_progress');
      const suffix = active === undefined ? '' : `，进行中：${active.content}`;
      return Promise.resolve({ output: `已更新任务列表（共 ${input.todos.length} 项${suffix}）` });
    },
  });
}
