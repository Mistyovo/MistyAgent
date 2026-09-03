import { useEffect, useRef, useState } from 'react';

import { Box, useApp, useInput } from 'ink';

import type { PermissionMode } from '#/config/schema';
import { nextPermissionMode } from '#/core/permission/modes';
import type { Session } from '#/core/session/session';
import type { ToolRegistry } from '#/core/tools/registry';

import { ApprovalDialog } from './components/ApprovalDialog';
import { MessageList } from './components/MessageList';
import { PromptInput } from './components/PromptInput';
import { StatusBar } from './components/StatusBar';
import { StreamingArea } from './components/StreamingArea';
import { useSessionController } from './controllers/session-events';

export interface AppProps {
  session: Session;
  registry: ToolRegistry;
  model: string;
  cwd: string;
}

const EXIT_ARM_MS = 3000;

/**
 * 全局键位：
 * - Esc：中断进行中的 turn（审批弹窗打开时由弹窗处理为拒绝）
 * - Shift+Tab：循环切换权限模式（Windows 终端到达为 \x1b[Z，ink 解析为 tab+shift）
 * - Ctrl+C：第一次提示"再按一次退出"（turn 在飞则顺手中断），3 秒内第二次退出
 */
export function App({ session, registry, model, cwd }: AppProps) {
  const { exit } = useApp();
  const { state, submit, replyApproval } = useSessionController(session, registry);
  const [mode, setMode] = useState<PermissionMode>(() => session.getPermissionMode());
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimerRef = useRef<NodeJS.Timeout | null>(null);

  const busy = state.streaming.active;
  const approval = state.pendingApproval;

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) {
        clearTimeout(exitTimerRef.current);
      }
    },
    [],
  );

  useInput((input, key) => {
    if (approval !== null) {
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

  return (
    <Box flexDirection="column">
      <MessageList blocks={state.blocks} />
      <StreamingArea streaming={state.streaming} />
      {approval !== null && (
        <ApprovalDialog
          request={approval}
          cwd={cwd}
          onReply={(reply) => {
            replyApproval(approval.id, reply);
          }}
        />
      )}
      <PromptInput
        busy={busy}
        queuedCount={state.queuedCount}
        disabled={approval !== null}
        onSubmit={submit}
      />
      <StatusBar
        cwd={cwd}
        model={model}
        mode={mode}
        usage={state.lastUsage}
        busy={busy}
        exitArmed={exitArmed}
      />
    </Box>
  );
}
