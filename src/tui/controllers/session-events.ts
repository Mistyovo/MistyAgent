import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApprovalReply } from '#/core/permission/approval';
import type { QuestionReply } from '#/core/question';
import type { Session } from '#/core/session/session';
import type { ToolRegistry } from '#/core/tools/registry';

import {
  initialSessionUiState,
  reduceClearBlocks,
  reduceDialogReplied,
  reduceEvent,
  reduceNotice,
  reduceStreamSync,
  reduceSubmit,
  type DescribeCall,
  type SessionUiState,
} from './session-reducer';
import { createThrottledEmitter, type Throttled } from './stream-utils';

/** 流式 delta 的 React 更新节流间隔 */
export const STREAM_THROTTLE_MS = 50;

export interface SessionController {
  state: SessionUiState;
  submit(text: string): void;
  replyApproval(id: string, reply: ApprovalReply): void;
  replyQuestion(id: string, reply: QuestionReply): void;
  /** 本地提示上屏（斜杠命令输出等） */
  notice(text: string): void;
  /** /clear：清空 Static 区 */
  clearBlocks(): void;
}

/**
 * 订阅 session 事件流并聚合成 React state。
 * text/reasoning delta 先进内存缓冲、50ms 节流入 state；
 * 其余事件（turn/工具/审批边界）先冲掉缓冲再即时聚合，保证顺序。
 */
export function useSessionController(session: Session, registry: ToolRegistry): SessionController {
  const [state, setState] = useState(initialSessionUiState);

  const describe: DescribeCall = useCallback(
    (name, input) => registry.get(name)?.describeCall(input) ?? name,
    [registry],
  );

  const bufferRef = useRef({ text: '', reasoning: '' });
  const throttlerRef = useRef<Throttled | null>(null);
  if (throttlerRef.current === null) {
    throttlerRef.current = createThrottledEmitter(() => {
      const { text, reasoning } = bufferRef.current;
      if (text === '' && reasoning === '') {
        return;
      }
      bufferRef.current = { text: '', reasoning: '' };
      setState((s) => reduceStreamSync(s, text, reasoning));
    }, STREAM_THROTTLE_MS);
  }

  useEffect(() => {
    const throttler = throttlerRef.current;
    if (throttler === null) {
      return undefined;
    }
    const off = session.onEvent((event) => {
      if (event.type === 'text-delta') {
        bufferRef.current.text += event.text;
        throttler.schedule();
        return;
      }
      if (event.type === 'reasoning-delta') {
        bufferRef.current.reasoning += event.text;
        throttler.schedule();
        return;
      }
      throttler.flush();
      setState((s) => reduceEvent(s, event, describe));
    });
    return () => {
      off();
      throttler.cancel();
    };
  }, [session, describe]);

  const submit = useCallback(
    (text: string) => {
      setState((s) => reduceSubmit(s, text));
      void session.submit({ type: 'user-turn', text });
    },
    [session],
  );

  const replyApproval = useCallback(
    (id: string, reply: ApprovalReply) => {
      setState((s) => reduceDialogReplied(s));
      session.submit({ type: 'approval-reply', id, reply });
    },
    [session],
  );

  const replyQuestion = useCallback(
    (id: string, reply: QuestionReply) => {
      setState((s) => reduceDialogReplied(s));
      session.submit({ type: 'question-reply', id, reply });
    },
    [session],
  );

  const notice = useCallback((text: string) => {
    setState((s) => reduceNotice(s, text));
  }, []);

  const clearBlocks = useCallback(() => {
    setState((s) => reduceClearBlocks(s));
  }, []);

  return { state, submit, replyApproval, replyQuestion, notice, clearBlocks };
}
