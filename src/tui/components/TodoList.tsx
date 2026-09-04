import { memo } from 'react';

import { Box, Text } from 'ink';

import type { TodoItem } from '#/core/todos';

import { useTerminalTextWrap } from '../terminal-text';

export interface TodoListProps {
  todos: TodoItem[];
}

/** 会话级任务列表：☐ pending / ▶ in_progress（高亮）/ ☑ done（淡化）；空列表不渲染。
 *  ▶ 在 legacy-cjk 终端物理占 2 格（ink 按 1 格预算），label 又是模型生成的不可控
 *  文本，整行必须过物理宽度折行（reserve 1 = paddingX 左格）。 */
export const TodoList = memo(function TodoList({ todos }: TodoListProps) {
  const wrap = useTerminalTextWrap();
  if (todos.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {todos.map((todo, index) => {
        const label =
          todo.status === 'in_progress' && todo.activeForm !== undefined
            ? todo.activeForm
            : todo.content;
        if (todo.status === 'in_progress') {
          return (
            <Text key={`${index}-${todo.content}`} color="cyan" bold>
              {wrap(`▶ ${label}`, 1)}
            </Text>
          );
        }
        if (todo.status === 'done') {
          return <Text key={`${index}-${todo.content}`} dimColor>{wrap(`☑ ${label}`, 1)}</Text>;
        }
        return <Text key={`${index}-${todo.content}`}>{wrap(`☐ ${label}`, 1)}</Text>;
      })}
    </Box>
  );
});
