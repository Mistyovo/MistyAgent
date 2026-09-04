import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { PlanModeHost } from '../../plan-mode';
import { defineTool, type Tool } from '../tool';

const enterInputSchema = z.object({
  reason: z.string().optional().describe('进入计划模式的原因（一句话）'),
});

const exitInputSchema = z.object({
  plan: z.string().min(1).describe('完整的实施计划（markdown），提交给用户审批'),
});

/**
 * 进入计划模式工具（对标 Claude Code EnterPlanMode）：模型判断任务复杂、需要先
 * 调研再动手时主动调用。interactive=true：工具本身即用户对话的一环，权限流水线
 * 在 deny 规则后直接放行（plan 模式下也可调用，幂等提示）。
 * accesses 为 execute：模式切换是会话级状态变更，串行调度。
 */
export function createEnterPlanModeTool(host?: PlanModeHost): Tool {
  return defineTool({
    name: 'enter_plan_mode',
    description:
      '进入计划模式：任务复杂、需要先调研再动手时调用。进入后只能只读探索' +
      '（write / edit / bash 等写/执行类工具会被拒绝）；调研完成后用 exit_plan_mode ' +
      '提交实施计划，经用户批准后开始执行。简单明确的任务不要进入计划模式。',
    inputSchema: enterInputSchema,
    interactive: true,
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) =>
      input.reason !== undefined && input.reason !== ''
        ? `进入计划模式：${input.reason}`
        : '进入计划模式',
    call: () => {
      if (host === undefined) {
        return Promise.resolve({ output: '当前环境不支持计划模式（无会话状态）。', isError: true });
      }
      if (!host.enterPlanMode()) {
        return Promise.resolve({
          output: '已在计划模式中，无需重复进入。完成只读调研后用 exit_plan_mode 提交计划。',
        });
      }
      return Promise.resolve({
        output:
          '已进入计划模式：现在只能进行只读探索（read / glob / grep 等），写/执行类工具调用会被拒绝。' +
          '调研完成后调用 exit_plan_mode 提交实施计划，经用户批准后开始执行。',
      });
    },
  });
}

/**
 * 退出计划模式工具（对标 Claude Code ExitPlanMode）：提交计划全文并挂起等用户
 * 批准（复用 plan-approval 通道）。批准后退出计划模式（切回进入前的权限模式），
 * 模型继续当前 turn 按计划执行；拒绝时回喂反馈，模型修订后可再次提交。
 * 挂起期间 interrupt / print 无头模式自动落定拒绝。
 */
export function createExitPlanModeTool(host?: PlanModeHost): Tool {
  return defineTool({
    name: 'exit_plan_mode',
    description:
      '提交实施计划并请求退出计划模式。仅在计划模式中、已完成只读调研后调用；' +
      '用户批准后自动退出计划模式并开始执行，被拒绝时按反馈修订计划后重新提交。',
    inputSchema: exitInputSchema,
    interactive: true,
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) => {
      const firstLine = input.plan.split('\n')[0] ?? '';
      return `提交计划：${firstLine.length > 50 ? `${firstLine.slice(0, 50)}…` : firstLine}`;
    },
    call: async (input, ctx) => {
      if (host === undefined) {
        return { output: '当前环境不支持计划模式（无会话状态）。', isError: true };
      }
      if (!host.isPlanMode()) {
        return {
          output: '当前不在计划模式中，无需提交计划；请按现有权限模式直接继续。',
          isError: true,
        };
      }
      const reply = await host.requestPlanApproval(
        { id: randomUUID(), plan: input.plan },
        ctx.signal,
      );
      if (reply.approved) {
        host.exitPlanMode();
        return { output: '计划已获批准，已退出计划模式。请严格按计划开始执行。' };
      }
      if (ctx.signal.aborted) {
        return { output: 'interrupted by user', isError: true };
      }
      const feedback =
        reply.feedback !== undefined && reply.feedback !== '' ? `用户反馈：${reply.feedback}。` : '';
      return {
        output: `计划被拒绝。${feedback}请修订计划后再次调用 exit_plan_mode 提交。`,
        isError: true,
      };
    },
  });
}
