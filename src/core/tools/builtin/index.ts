import type { ChatProvider } from '#/provider/types';

import type { PermissionContext } from '../../permission/pipeline';
import type { PlanModeHost } from '../../plan-mode';
import type { AskUserFn } from '../../question';
import type { SubagentDefinition } from '../../subagents';
import { TaskManager } from '../../tasks';
import { TodoStore } from '../../todos';
import { ToolRegistry } from '../registry';
import type { Tool } from '../tool';

import { createAgentTool } from './agent';
import { createAskUserTool } from './ask-user';
import { createBashTool } from './bash';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan-mode';
import { readTool } from './read';
import { createTaskListTool, createTaskOutputTool, createTaskStopTool } from './tasks';
import { createTodoTool } from './todo';
import { webFetchTool } from './web-fetch';
import { webSearchTool } from './web-search';
import { writeTool } from './write';

/** 无状态内置工具；bash / todo / agent / task_* 依赖宿主状态，由 createBuiltinRegistry 按宿主能力装配 */
export const builtinTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  webFetchTool,
  webSearchTool,
];

/**
 * 宿主能力：有状态（todo / 后台任务）、依赖 provider（agent）或需要用户交互（ask_user）
 * 的内置工具在 registry 创建时从这里闭包注入。
 */
export interface BuiltinHost {
  /** 会话级 todo 存储；缺省时 registry 自建（与 Session 事件流断开） */
  todoStore?: TodoStore;
  /** 提供后注册 agent 子代理工具 */
  provider?: ChatProvider;
  getModel?: () => string;
  /** 提供后 ask_user 可挂起等用户回答；缺省（无头模式）时工具回喂"自行决策" */
  askUser?: AskUserFn | undefined;
  /**
   * 计划模式宿主（Session 天然满足）：提供后 enter_plan_mode / exit_plan_mode
   * 接管会话的计划模式状态与计划审批；缺省时两工具回喂"不支持计划模式"
   */
  planMode?: PlanModeHost;
  /** 后台任务管理器；缺省时 registry 自建（任务事件不进 Session 事件流） */
  taskManager?: TaskManager;
  /** 自定义子代理定义（.misty/agents/*.md 经 loadSubagentDefinitions 加载）；缺省只有内置 explore/plan */
  subagents?: SubagentDefinition[];
  /** 主会话权限上下文来源；缺省时子代理按 bypassPermissions 判定（只读工具本就自动放行） */
  getPermissionContext?: () => PermissionContext;
}

export function createBuiltinRegistry(host?: BuiltinHost): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtinTools) {
    registry.register(tool);
  }
  const taskManager = host?.taskManager ?? new TaskManager();
  registry.register(createBashTool(taskManager));
  registry.register(createTaskOutputTool(taskManager));
  registry.register(createTaskStopTool(taskManager));
  registry.register(createTaskListTool(taskManager));
  registry.register(createTodoTool(host?.todoStore ?? new TodoStore()));
  registry.register(createAskUserTool(host?.askUser));
  registry.register(createEnterPlanModeTool(host?.planMode));
  registry.register(createExitPlanModeTool(host?.planMode));
  if (host?.provider !== undefined && host.getModel !== undefined) {
    registry.register(
      createAgentTool({
        provider: host.provider,
        getModel: host.getModel,
        tasks: taskManager,
        ...(host.subagents !== undefined ? { subagents: host.subagents } : {}),
        ...(host.getPermissionContext !== undefined
          ? { getPermissionContext: host.getPermissionContext }
          : {}),
      }),
    );
  }
  return registry;
}
