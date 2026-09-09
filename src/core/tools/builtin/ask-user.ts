import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AskUserFn } from '../../question';
import { defineTool, type Tool } from '../tool';

const inputSchema = z.object({
  question: z.string().describe('The question to ask the user'),
  options: z
    .array(
      z.object({
        label: z.string().describe('Short option label'),
        description: z.string().optional().describe('Additional explanation for the option'),
      }),
    )
    .min(2)
    .max(4)
    .describe('Options for the user to choose from (2-4)'),
  multiSelect: z
    .boolean()
    .optional()
    .describe('When true, multiple options may be selected; single choice by default'),
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
      'Ask the user a question and wait for a choice; use it for branching decisions only the user can make (choosing between designs, confirming a blast radius, ...). ' +
      'Ask everything in one question, offer 2-4 options covering the main directions, and put the recommended one first labelled "(recommended)". ' +
      'The user may skip the question — then decide yourself from the information you have. Do not ask trivial questions; if you can decide it yourself, decide.',
    inputSchema,
    interactive: true,
    accesses: () => [{ kind: 'execute' }],
    describeCall: (input) =>
      `Ask: ${input.question.length > 50 ? `${input.question.slice(0, 50)}…` : input.question}`,
    call: async (input, ctx) => {
      if (askUser === undefined) {
        return {
          output:
            'Running headless (print mode), so the user cannot be asked; decide from the information you have and continue.',
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
          output:
            'The user cancelled the question without answering. Decide from the information you have and continue.',
          isError: true,
        };
      }
      if (reply.answers.length === 0) {
        return {
          output:
            'The user selected no option. Decide from the information you have and continue.',
          isError: true,
        };
      }
      return { output: `User selected: ${reply.answers.join(', ')}` };
    },
  });
}
