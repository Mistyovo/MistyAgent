import { describe, expect, it } from 'vitest';

import type { AgentEvent, TodosUpdatedEvent } from '#/core/events';
import { Session } from '#/core/session/session';
import { TodoStore, validateTodos, type TodoItem } from '#/core/todos';
import { createTodoTool } from '#/core/tools/builtin/todo';
import type { ToolContext } from '#/core/tools/tool';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();

const ctx: ToolContext = { cwd, signal: new AbortController().signal };

function todo(content: string, status: TodoItem['status'], activeForm?: string): TodoItem {
  return activeForm === undefined ? { content, status } : { content, status, activeForm };
}

function updatedEvents(events: AgentEvent[]): TodosUpdatedEvent[] {
  return events.filter((e): e is TodosUpdatedEvent => e.type === 'todos-updated');
}

describe('validateTodos', () => {
  it('同一时刻至多一个 in_progress', () => {
    const error = validateTodos([todo('a', 'in_progress'), todo('b', 'in_progress')], []);
    expect(error).toContain('in_progress');
    expect(validateTodos([todo('a', 'in_progress'), todo('b', 'pending')], [])).toBeNull();
  });

  it('前后都为 done 的条目 content 不可变', () => {
    const prev = [todo('a', 'done'), todo('b', 'pending')];
    expect(validateTodos([todo('a 改名', 'done'), todo('b', 'pending')], prev)).toContain(
      '已完成的任务不能修改内容',
    );
    expect(validateTodos([todo('a', 'done'), todo('b', 'in_progress')], prev)).toBeNull();
  });
});

describe('TodoStore', () => {
  it('全量替换语义：replace 覆盖旧列表并通知监听器', () => {
    const store = new TodoStore();
    const seen: TodoItem[][] = [];
    store.onChange((todos) => seen.push(todos));

    expect(store.replace([todo('a', 'pending'), todo('b', 'pending')])).toBeNull();
    expect(store.replace([todo('a', 'done')])).toBeNull();

    expect(store.list()).toEqual([todo('a', 'done')]);
    expect(seen).toEqual([
      [todo('a', 'pending'), todo('b', 'pending')],
      [todo('a', 'done')],
    ]);
  });

  it('校验失败：返回错误消息，store 与监听器不受影响', () => {
    const store = new TodoStore();
    const seen: TodoItem[][] = [];
    store.onChange((todos) => seen.push(todos));
    store.replace([todo('a', 'in_progress')]);

    const error = store.replace([todo('a', 'in_progress'), todo('b', 'in_progress')]);

    expect(error).toContain('in_progress');
    expect(store.list()).toEqual([todo('a', 'in_progress')]);
    expect(seen).toHaveLength(1);
  });

  it('clear 清空并通知；空列表重复 clear 不再通知', () => {
    const store = new TodoStore();
    const seen: TodoItem[][] = [];
    store.onChange((todos) => seen.push(todos));
    store.replace([todo('a', 'pending')]);

    store.clear();
    store.clear();

    expect(store.list()).toEqual([]);
    expect(seen).toEqual([[todo('a', 'pending')], []]);
  });

  it('监听器抛异常被隔离', () => {
    const store = new TodoStore();
    const seen: TodoItem[][] = [];
    store.onChange(() => {
      throw new Error('boom');
    });
    store.onChange((todos) => seen.push(todos));

    expect(store.replace([todo('a', 'pending')])).toBeNull();
    expect(seen).toHaveLength(1);
  });
});

describe('todo 工具', () => {
  it('合法输入全量替换 store，返回摘要', async () => {
    const store = new TodoStore();
    const tool = createTodoTool(store);

    const result = await tool.call(
      { todos: [todo('实现功能', 'in_progress', '正在实现功能'), todo('写测试', 'pending')] },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('共 2 项');
    expect(result.output).toContain('进行中：实现功能');
    expect(store.list()).toEqual([
      todo('实现功能', 'in_progress', '正在实现功能'),
      todo('写测试', 'pending'),
    ]);
  });

  it('校验失败转为 isError 结果（不抛出、不中断 loop）', async () => {
    const store = new TodoStore();
    const tool = createTodoTool(store);

    const result = await tool.call(
      { todos: [todo('a', 'in_progress'), todo('b', 'in_progress')] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('in_progress');
    expect(store.list()).toEqual([]);
  });

  it('schema 之外的结构错误由 defineTool 包装层抛出', () => {
    const store = new TodoStore();
    const tool = createTodoTool(store);
    expect(() => tool.call({ todos: [{ content: '', status: 'pending' }] }, ctx)).toThrow();
  });
});

describe('session 接线', () => {
  it('todo 工具调用经 session 派发 todos-updated 事件（携带全量列表）', async () => {
    const store = new TodoStore();
    const provider = new FakeProvider([
      toolCallStep([
        {
          name: 'todo',
          arguments:
            '{"todos":[{"content":"任务A","status":"in_progress"},{"content":"任务B","status":"pending"}]}',
        },
      ]),
      textStep('done'),
    ]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: [createTodoTool(store)],
      cwd,
      todos: store,
      permission: { mode: 'bypassPermissions' },
    });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));

    const result = await session.submit({ type: 'user-turn', text: 'go' });

    expect(result.stopReason).toBe('completed');
    const updates = updatedEvents(events);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.todos).toEqual([todo('任务A', 'in_progress'), todo('任务B', 'pending')]);
  });

  it('newSession 清空 todo 列表并派发空列表事件', async () => {
    const store = new TodoStore();
    const provider = new FakeProvider([
      toolCallStep([{ name: 'todo', arguments: '{"todos":[{"content":"任务A","status":"done"}]}' }]),
      textStep('done'),
    ]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: [createTodoTool(store)],
      cwd,
      todos: store,
      permission: { mode: 'bypassPermissions' },
    });
    const events: AgentEvent[] = [];
    session.onEvent((event) => events.push(event));
    await session.submit({ type: 'user-turn', text: 'go' });

    session.newSession();

    expect(store.list()).toEqual([]);
    expect(updatedEvents(events).at(-1)!.todos).toEqual([]);
  });
});
