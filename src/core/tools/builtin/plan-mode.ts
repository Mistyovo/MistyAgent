import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { PlanModeHost } from '../../plan-mode';
import { defineTool, type Tool } from '../tool';

const enterInputSchema = z.object({
  reason: z.string().optional().describe('Why you are entering plan mode (one sentence)'),
});

const exitInputSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe('The complete implementation plan (markdown), submitted for user approval'),
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
      'Enter plan mode: call this when a task is complex, wide-reaching, or involves a trade-off and you need to investigate before acting. ' +
      'Inside plan mode only read-only exploration is allowed (write / edit / bash and other write or execute tools are refused). ' +
      'When the investigation is done, submit the implementation plan with exit_plan_mode and start executing once the user approves. ' +
      'Do not enter plan mode for simple, well-specified tasks.',
    inputSchema: enterInputSchema,
    interactive: true,
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) =>
      input.reason !== undefined && input.reason !== ''
        ? `Enter plan mode: ${input.reason}`
        : 'Enter plan mode',
    call: () => {
      if (host === undefined) {
        return Promise.resolve({
          output: 'Plan mode is not supported in this environment (no session state).',
          isError: true,
        });
      }
      if (!host.enterPlanMode()) {
        return Promise.resolve({
          output:
            'Already in plan mode — no need to enter again. Once the read-only investigation is done, submit the plan with exit_plan_mode.',
        });
      }
      return Promise.resolve({
        output:
          'Entered plan mode: only read-only exploration (read / glob / grep, ...) is possible now; write or execute tool calls are refused. ' +
          'When the investigation is done, call exit_plan_mode to submit the implementation plan and start executing once the user approves.',
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
      'Submit the implementation plan and request exit from plan mode. Call it only inside plan mode, after the read-only investigation is complete. ' +
      'The plan must be concrete enough to execute directly (markdown: step-by-step actions, the files each step touches, ordering, risks, and how to verify). ' +
      'Once the user approves, plan mode exits automatically and you start executing; if it is rejected, revise the plan per the feedback and submit again.',
    inputSchema: exitInputSchema,
    interactive: true,
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) => {
      const firstLine = input.plan.split('\n')[0] ?? '';
      return `Submit plan: ${firstLine.length > 50 ? `${firstLine.slice(0, 50)}…` : firstLine}`;
    },
    call: async (input, ctx) => {
      if (host === undefined) {
        return {
          output: 'Plan mode is not supported in this environment (no session state).',
          isError: true,
        };
      }
      if (!host.isPlanMode()) {
        return {
          output:
            'Not in plan mode, so there is no plan to submit; continue directly under the current permission mode.',
          isError: true,
        };
      }
      const reply = await host.requestPlanApproval(
        { id: randomUUID(), plan: input.plan },
        ctx.signal,
      );
      if (reply.approved) {
        host.exitPlanMode();
        return {
          output: 'The plan was approved and plan mode has exited. Start executing the plan exactly as written.',
        };
      }
      if (ctx.signal.aborted) {
        return { output: 'interrupted by user', isError: true };
      }
      const feedback =
        reply.feedback !== undefined && reply.feedback !== ''
          ? `User feedback: ${reply.feedback}. `
          : '';
      return {
        output: `The plan was rejected. ${feedback}Revise the plan and submit it again with exit_plan_mode.`,
        isError: true,
      };
    },
  });
}
