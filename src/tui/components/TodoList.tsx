import { Box, Text } from 'ink';

import type { TodoItem } from '#/core/todos';

export interface TodoListProps {
  todos: TodoItem[];
}

/** 会话级任务列表：☐ pending / ▶ in_progress（高亮）/ ☑ done（淡化）；空列表不渲染 */
export function TodoList({ todos }: TodoListProps) {
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
              {`▶ ${label}`}
            </Text>
          );
        }
        if (todo.status === 'done') {
          return <Text key={`${index}-${todo.content}`} dimColor>{`☑ ${label}`}</Text>;
        }
        return <Text key={`${index}-${todo.content}`}>{`☐ ${label}`}</Text>;
      })}
    </Box>
  );
}
