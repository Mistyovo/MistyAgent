import { useCallback, useEffect, useRef, useState } from 'react';

import { Box, useApp, useInput } from 'ink';

import type { PermissionMode } from '#/config/schema';
import type { McpManager } from '#/core/mcp/manager';
import { nextPermissionMode } from '#/core/permission/modes';
import type { Session } from '#/core/session/session';
import type { ToolRegistry } from '#/core/tools/registry';

import { isSlashCommand, runSlashCommand, type CommandContext } from './commands';
import { ApprovalDialog } from './components/ApprovalDialog';
import { MessageList } from './components/MessageList';
import { PlanApprovalDialog } from './components/PlanApprovalDialog';
import { PromptInput } from './components/PromptInput';
import { QuestionDialog } from './components/QuestionDialog';
import { StatusBar } from './components/StatusBar';
import { StreamingArea } from './components/StreamingArea';
import { TodoList } from './components/TodoList';
import { useSessionController } from './controllers/session-events';

export interface AppProps {
  session: Session;
  registry: ToolRegistry;
  model: string;
  cwd: string;
  /** 未配置 MCP 时缺省（/mcp 命令提示未配置） */
  mcpManager?: McpManager | undefined;
}

const EXIT_ARM_MS = 3000;

/**
 * 全局键位：
 * - Esc：中断进行中的 turn（弹窗打开时由弹窗处理：审批=拒绝，提问=跳过，计划批准=拒绝）
 * - Shift+Tab：循环切换权限模式（Windows 终端到达为 \x1b[Z，ink 解析为 tab+shift）；
 *   切到 plan 即进入完整计划模式，计划模式中切走即退出（Session.setPermissionMode 内聚）
 * - Ctrl+C：第一次提示"再按一次退出"（turn 在飞则顺手中断），3 秒内第二次退出
 *
 * 输入路由：/ 开头走斜杠命令框架（不进 session.submit），其余按 user-turn 提交。
 */
export function App({ session, registry, model: initialModel, cwd, mcpManager }: AppProps) {
  const { exit } = useApp();
  const { state, submit, replyApproval, replyQuestion, replyPlanApproval, notice, clearBlocks } =
    useSessionController(session, registry);
  const [model, setModel] = useState(initialModel);
  const [mode, setMode] = useState<PermissionMode>(() => session.getPermissionMode());
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimerRef = useRef<NodeJS.Timeout | null>(null);

  const busy = state.streaming.active;
  const dialog = state.pendingDialogs[0] ?? null;

  // 计划模式进/退可由模型工具在 turn 内触发（权限模式随之切换），状态栏经事件同步；
  // 模型 fallback 仅当前 turn 生效（session 模型不变），状态栏跟随事件，turn 结束回读主模型
  useEffect(
    () =>
      session.onEvent((event) => {
        if (event.type === 'plan-mode-changed') {
          setMode(event.mode);
        }
        if (event.type === 'model-fallback') {
          setModel(event.to);
        }
        if (event.type === 'turn-complete') {
          setModel(session.getModel());
        }
      }),
    [session],
  );

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
      }
    },
    [],
  );

  useInput((input, key) => {
    if (dialog !== null) {
      return;
    }
    if (key.escape) {
      if (busy) {
        session.interrupt();
      }
      return;
    }
    if (key.tab && key.shift) {
      const next = nextPermissionMode(mode);
      session.setPermissionMode(next);
      setMode(next);
      return;
    }
    if (key.ctrl && input === 'c') {
      if (busy) {
        session.interrupt();
      }
      if (exitArmed) {
        exit();
        return;
      }
      setExitArmed(true);
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
      }
      exitTimerRef.current = setTimeout(() => {
        setExitArmed(false);
      }, EXIT_ARM_MS);
    }
  });

  // useCallback 固定引用：流式期间 App 每次重渲都新建 onSubmit 会让 memo 后的 PromptInput 失效；
  // ctx 只在斜杠命令真正执行时构造，不进每帧渲染路径
  const handleSubmit = useCallback(
    (text: string): void => {
      if (isSlashCommand(text)) {
        const ctx: CommandContext = {
          session,
          busy,
          notice,
          clearBlocks,
          setModel: (next) => {
            session.setModel(next);
            setModel(next);
          },
          setMode: (next) => {
            session.setPermissionMode(next);
            setMode(next);
          },
          mcpServers: mcpManager === undefined ? undefined : () => mcpManager.serverStatuses(),
          exit,
        };
        void runSlashCommand(text, ctx);
        return;
      }
      submit(text);
    },
    [session, busy, notice, clearBlocks, mcpManager, exit, submit],
  );

  return (
    <Box flexDirection="column">
      <MessageList blocks={state.blocks} />
      <StreamingArea streaming={state.streaming} />
      {dialog?.kind === 'approval' && (
        <ApprovalDialog
          request={dialog.request}
          cwd={cwd}
          onReply={(reply) => {
            replyApproval(dialog.request.id, reply);
          }}
        />
      )}
      {dialog?.kind === 'question' && (
        <QuestionDialog
          request={dialog.request}
          onReply={(reply) => {
            replyQuestion(dialog.request.id, reply);
          }}
        />
      )}
      {dialog?.kind === 'plan-approval' && (
        <PlanApprovalDialog
          request={dialog.request}
          onReply={(reply) => {
            replyPlanApproval(dialog.request.id, reply);
          }}
        />
      )}
      <PromptInput
        busy={busy}
        queuedCount={state.queuedCount}
        disabled={dialog !== null}
        onSubmit={handleSubmit}
      />
      <TodoList todos={state.todos} />
      <StatusBar
        cwd={cwd}
        model={model}
        mode={mode}
        usage={state.lastUsage}
        busy={busy}
        runningTasks={state.runningTasks}
        exitArmed={exitArmed}
      />
    </Box>
  );
}
