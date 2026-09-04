import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AskUserFn } from '../../question';
import { defineTool, type Tool } from '../tool';

const inputSchema = z.object({
  question: z.string().describe('要问用户的问题'),
  options: z
    .array(
      z.object({
        label: z.string().describe('选项简述'),
        description: z.string().optional().describe('选项的补充说明'),
      }),
    )
    .min(2)
    .max(4)
    .describe('供用户选择的选项（2-4 个）'),
  multiSelect: z.boolean().optional().describe('true 表示允许多选，默认单选'),
});

/**
 * 提问工具（对标 Claude Code AskUserQuestion）：turn 进行中向用户提问并挂起等回答。
 * 交互能力由宿主经 createBuiltinRegistry 闭包注入；缺省（无头 print 模式）时
 * 不发起提问，直接回喂"自行决策"。accesses 为 execute：挂起等回答期间独占调度，
 * 同批其他调用等回答落定后再运行。
 */
export function createAskUserTool(askUser?: AskUserFn): Tool {
  return defineTool({
    name: 'ask_user',
    description:
      '向用户提问并等待选择，用于需要用户拍板的分支决策（方案取舍、确认范围等）。' +
      '给出 2-4 个选项；用户可能跳过不答，此时根据已有信息自行决策。' +
      '不要问无关紧要的问题，能自行决定的不要问。',
    inputSchema,
    interactive: true,
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) =>
      `Ask: ${input.question.length > 50 ? `${input.question.slice(0, 50)}…` : input.question}`,
    call: async (input, ctx) => {
      if (askUser === undefined) {
        return {
          output: '当前为无头（print）模式，无法向用户提问；请根据已有信息自行决策并继续。',
          isError: true,
        };
      }
      const reply = await askUser(
        {
          id: randomUUID(),
          question: input.question,
          options: input.options,
          multiSelect: input.multiSelect,
        },
        ctx.signal,
      );
      if ('cancelled' in reply) {
        if (ctx.signal.aborted) {
          return { output: 'interrupted by user', isError: true };
        }
        return {
          output: '用户取消了提问（未作答）。请根据已有信息自行决策并继续。',
          isError: true,
        };
      }
      if (reply.answers.length === 0) {
        return {
          output: '用户没有选择任何选项。请根据已有信息自行决策并继续。',
          isError: true,
        };
      }
      return { output: `用户选择了：${reply.answers.join('、')}` };
    },
  });
}
