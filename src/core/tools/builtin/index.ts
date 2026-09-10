import type { ChatProvider } from '#/provider/types';

import type { TaskBoard } from '../../board';
import type { CheckpointStore } from '../../checkpoint/checkpoint';
import { withCheckpoint } from '../../checkpoint/wrap';
import type { CompetitionClient } from '../../competition';
import type { PermissionContext } from '../../permission/pipeline';
import type { PlanModeHost } from '../../plan-mode';
import type { AskUserFn } from '../../question';
import type { SkillDefinition } from '../../skills/types';
import type { SubagentDefinition } from '../../subagents';
import { TaskManager } from '../../tasks';
import { TodoStore } from '../../todos';
import { ToolRegistry } from '../registry';
import type { Tool } from '../tool';

import { createAgentTool } from './agent';
import { createAskUserTool } from './ask-user';
import { createBashTool } from './bash';
import { createCompetitionTools } from './competition';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan-mode';
import { readTool } from './read';
import { createSkillTool } from './skill';
import { createTaskListTool, createTaskOutputTool, createTaskStopTool } from './tasks';
import { createTodoTool } from './todo';
import { webFetchTool } from './web-fetch';
import { webSearchTool } from './web-search';
import { writeTool } from './write';

/**
 * 无状态内置工具；write/edit（检查点包装）、bash / todo / agent / task_* 依赖宿主状态，
 * 由 createBuiltinRegistry 按宿主能力装配
 */
export const builtinTools: Tool[] = [
  readTool,
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
  /** 任务级共享证据板：提供后子代理注入协作纪律段并收割结论中的事实/死路条目（/clear 时由宿主 reset） */
  board?: TaskBoard;
  /** 技能定义（经 loadSkillDefinitions + getBundledSkillDefinitions 汇总）；非空时注册 skill 工具 */
  skills?: SkillDefinition[];
  /** 主会话权限上下文来源；缺省时子代理按 bypassPermissions 判定（只读工具本就自动放行） */
  getPermissionContext?: () => PermissionContext;
  /** 检查点存储：提供后 write/edit 首次改动某文件前自动快照（/rewind 回滚的数据来源） */
  checkpoints?: CheckpointStore | undefined;
  /** 赛事平台客户端（队伍 token 经 MISTY_CTF_TOKEN 注入）：提供后注册 competition_* 三件套 */
  competition?: CompetitionClient | undefined;
}

export function createBuiltinRegistry(host?: BuiltinHost): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtinTools) {
    registry.register(tool);
  }
  // write/edit 经 withCheckpoint 包装：turn 内首写某文件前快照进检查点；宿主未提供则原样注册
  const checkpoints = host?.checkpoints;
  registry.register(checkpoints === undefined ? writeTool : withCheckpoint(writeTool, checkpoints));
  registry.register(checkpoints === undefined ? editTool : withCheckpoint(editTool, checkpoints));
  const taskManager = host?.taskManager ?? new TaskManager();
  registry.register(createBashTool(taskManager));
  registry.register(createTaskOutputTool(taskManager));
  registry.register(createTaskStopTool(taskManager));
  registry.register(createTaskListTool(taskManager));
  registry.register(createTodoTool(host?.todoStore ?? new TodoStore()));
  registry.register(createAskUserTool(host?.askUser));
  if (host?.competition !== undefined) {
    for (const tool of createCompetitionTools(host.competition)) {
      registry.register(tool);
    }
  }
  if (host?.skills !== undefined && host.skills.length > 0) {
    registry.register(createSkillTool(host.skills));
  }
  registry.register(createEnterPlanModeTool(host?.planMode));
  registry.register(createExitPlanModeTool(host?.planMode));
  if (host?.provider !== undefined && host.getModel !== undefined) {
    registry.register(
      createAgentTool({
        provider: host.provider,
        getModel: host.getModel,
        tasks: taskManager,
        ...(host.subagents !== undefined ? { subagents: host.subagents } : {}),
        ...(host.board !== undefined ? { board: host.board } : {}),
        ...(host.getPermissionContext !== undefined
          ? { getPermissionContext: host.getPermissionContext }
          : {}),
      }),
    );
  }
  return registry;
}
