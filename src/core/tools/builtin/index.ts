import type { ChatProvider } from '#/provider/types';

import { TodoStore } from '../../todos';
import { ToolRegistry } from '../registry';
import type { Tool } from '../tool';

import { createAgentTool } from './agent';
import { bashTool } from './bash';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { createTodoTool } from './todo';
import { writeTool } from './write';

/** 无状态内置工具；todo / agent 依赖宿主状态，由 createBuiltinRegistry 按宿主能力装配 */
export const builtinTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
];

/**
 * 宿主能力：有状态（todo）或依赖 provider（agent）的内置工具在 registry
 * 创建时从这里闭包注入。
 */
export interface BuiltinHost {
  /** 会话级 todo 存储；缺省时 registry 自建（与 Session 事件流断开） */
  todoStore?: TodoStore;
  /** 提供后注册 agent 子代理工具 */
  provider?: ChatProvider;
  getModel?: () => string;
}

export function createBuiltinRegistry(host?: BuiltinHost): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtinTools) {
    registry.register(tool);
  }
  registry.register(createTodoTool(host?.todoStore ?? new TodoStore()));
  if (host?.provider !== undefined && host.getModel !== undefined) {
    registry.register(createAgentTool({ provider: host.provider, getModel: host.getModel }));
  }
  return registry;
}
