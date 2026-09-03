import type { ToolCall } from '#/provider/types';

import { errorMessage } from '../errors';
import type { EventDispatcher } from '../events';
import type { ApprovalRequest } from '../permission/approval';
import { evaluatePermission, type PermissionRuntime } from '../permission/pipeline';
import type { ToolRegistry } from '../tools/registry';
import { accessesConflict, type ToolAccess, type ToolResult } from '../tools/tool';

import type { DoomLoopDetector } from './doom-loop';

export interface ToolCallOutcome {
  toolCall: ToolCall;
  /** JSON 解析后的参数；解析失败时为原始字符串 */
  input: unknown;
  result: ToolResult;
  durationMs: number;
  /** 从未真正执行（中断后补合成的结果） */
  skipped: boolean;
}

export interface ExecuteToolCallsDeps {
  registry: ToolRegistry;
  cwd: string;
  signal: AbortSignal;
  dispatchEvent: EventDispatcher;
  permission: PermissionRuntime;
  /** doom-loop 检测器（turn 级）；缺省不做重复调用检测 */
  doomLoop?: DoomLoopDetector | undefined;
}

const INTERRUPTED_RESULT: ToolResult = { output: 'interrupted by user', isError: true };

const errorOf = (message: string): ToolResult => ({ output: message, isError: true });

interface PendingCall {
  index: number;
  toolCall: ToolCall;
  input: unknown;
  accesses: ToolAccess[];
}

interface RunningCall extends PendingCall {
  promise: Promise<void>;
}

/**
 * 执行一个模型 step 产出的工具批。借鉴 Claude Code 的 partition 与
 * kimi-code 的 ToolScheduler：按顺序贪心启动，与运行中任务无资源冲突
 * （read vs read）的可并发，写/执行类串行；结果始终按原始顺序返回。
 *
 * 权限判定统一在调度前的 preflight 阶段逐个 await（串行）：
 * deny 与审批 reject 直接落 isError 结果；ask 会 dispatch
 * approval-requested 事件并挂起等 UI 回复。只有放行的调用进入并发调度，
 * 因此审批挂起不影响并发安全。
 *
 * 任何失败（参数解析、工具不存在、权限拒绝、call 抛异常）都转为 isError
 * 结果，不会向上抛出。中断时未启动的调用补合成 interrupted 结果。
 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  deps: ExecuteToolCallsDeps,
): Promise<ToolCallOutcome[]> {
  const outcomes: (ToolCallOutcome | undefined)[] = toolCalls.map(() => undefined);

  const record = (
    index: number,
    toolCall: ToolCall,
    input: unknown,
    result: ToolResult,
    durationMs: number,
    skipped: boolean,
  ): void => {
    outcomes[index] = { toolCall, input, result, durationMs, skipped };
    deps.dispatchEvent({
      type: 'tool-call-completed',
      toolCallId: toolCall.id,
      name: toolCall.name,
      input,
      output: result.output,
      isError: result.isError === true,
      durationMs,
    });
  };

  /** ask 分支：dispatch 事件并挂起等 UI 回复；返回 true 表示放行执行 */
  const askApproval = async (
    index: number,
    toolCall: ToolCall,
    input: unknown,
    reason: string,
  ): Promise<boolean> => {
    const tool = deps.registry.get(toolCall.name)!;
    const request: ApprovalRequest = {
      id: toolCall.id,
      toolName: tool.name,
      describeCall: tool.describeCall(input),
      input,
      reason,
    };
    // 先挂起再发事件：监听器可能在 dispatch 期间同步回复
    const replyPromise = deps.permission.approvals.request(request);
    deps.dispatchEvent({ type: 'approval-requested', request });
    const reply = await replyPromise;
    if (reply.decision !== 'reject') {
      // 'always' 的会话规则由 ApprovalManager.reply 写入
      return true;
    }
    const output = deps.signal.aborted
      ? INTERRUPTED_RESULT.output
      : `用户拒绝了本次操作${
          reply.feedback !== undefined && reply.feedback !== '' ? `：${reply.feedback}` : ''
        }`;
    record(index, toolCall, input, errorOf(output), 0, false);
    return false;
  };

  /** 参数解析、工具查找与权限判定；失败直接落结果，返回 null 表示不进入调度 */
  const preflight = async (index: number): Promise<PendingCall | null> => {
    const toolCall = toolCalls[index]!;
    let input: unknown = toolCall.arguments;
    try {
      input = JSON.parse(toolCall.arguments);
    } catch {
      record(index, toolCall, input, errorOf(`工具参数不是合法 JSON：${toolCall.arguments}`), 0, false);
      return null;
    }
    const tool = deps.registry.get(toolCall.name);
    if (tool === undefined) {
      record(index, toolCall, input, errorOf(`未知工具：${toolCall.name}`), 0, false);
      return null;
    }
    const decision = evaluatePermission(tool, input, deps.permission.getContext());
    if (decision.kind === 'deny') {
      record(index, toolCall, input, errorOf(`权限拒绝：${decision.reason}`), 0, false);
      return null;
    }
    // doom-loop：deny 之外的调用先记录签名，连续相同调用强制升级为 ask（bypass 模式也不例外）
    const doomLoopDetected = deps.doomLoop?.record(toolCall.name, toolCall.arguments) === true;
    const askReason = doomLoopDetected
      ? `检测到重复调用循环：${toolCall.name} 已连续多次以完全相同的参数调用。` +
        '确认确实需要继续请批准，否则拒绝并让模型调整思路。'
      : decision.kind === 'ask'
        ? decision.reason
        : null;
    if (askReason !== null && !(await askApproval(index, toolCall, input, askReason))) {
      return null;
    }
    return { index, toolCall, input, accesses: tool.accesses(input) };
  };

  const launch = (pending: PendingCall): RunningCall => {
    const tool = deps.registry.get(pending.toolCall.name)!;
    deps.dispatchEvent({
      type: 'tool-call-started',
      toolCallId: pending.toolCall.id,
      name: pending.toolCall.name,
      input: pending.input,
    });
    const startedAt = Date.now();
    const run = async (): Promise<void> => {
      let result: ToolResult;
      try {
        result = await tool.call(pending.input, { cwd: deps.cwd, signal: deps.signal });
      } catch (error) {
        result = errorOf(`工具执行异常：${errorMessage(error)}`);
      }
      record(pending.index, pending.toolCall, pending.input, result, Date.now() - startedAt, false);
    };
    return { ...pending, promise: run() };
  };

  const running: RunningCall[] = [];
  const pendings: PendingCall[] = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    if (deps.signal.aborted) {
      const toolCall = toolCalls[index]!;
      let input: unknown = toolCall.arguments;
      try {
        input = JSON.parse(toolCall.arguments);
      } catch {
        // input 保留原始字符串
      }
      record(index, toolCall, input, INTERRUPTED_RESULT, 0, true);
      continue;
    }
    const pending = await preflight(index);
    if (pending !== null) {
      pendings.push(pending);
    }
  }

  let cursor = 0;
  while (cursor < pendings.length || running.length > 0) {
    while (cursor < pendings.length && deps.signal.aborted !== true) {
      const next = pendings[cursor]!;
      if (running.some((task) => accessesConflict(task.accesses, next.accesses))) {
        break;
      }
      running.push(launch(next));
      cursor += 1;
    }
    if (running.length === 0) {
      break;
    }
    await Promise.race(running.map((task) => task.promise));
    for (let index = running.length - 1; index >= 0; index -= 1) {
      if (outcomes[running[index]!.index] !== undefined) {
        running.splice(index, 1);
      }
    }
  }

  // 中断后：在途任务已带 signal，等它们落定；未启动的补合成结果
  await Promise.all(running.map((task) => task.promise));
  for (const pending of pendings) {
    if (outcomes[pending.index] === undefined) {
      record(pending.index, pending.toolCall, pending.input, INTERRUPTED_RESULT, 0, true);
    }
  }

  return outcomes.map((outcome) => outcome!);
}
