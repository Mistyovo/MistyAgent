import { z } from 'zod';

import type { CompetitionClient, CompetitionQuestion } from '#/core/competition';
import { CompetitionApiError } from '#/core/competition';
import { errorMessage } from '#/core/errors';

import type { Tool } from '../tool';
import { defineTool } from '../tool';

import { errorResult, truncate } from './fs-utils';

const DESCRIPTION_PREVIEW_CHARS = 200;
const MAX_OUTPUT_CHARS = 30_000;

function formatConnection(question: CompetitionQuestion): string | undefined {
  const connection = question.connection;
  if (connection === undefined) {
    return undefined;
  }
  const url = typeof connection.docker_url === 'string' ? connection.docker_url : undefined;
  if (url !== undefined && url !== '') {
    return url;
  }
  const ip = typeof connection.docker_ip === 'string' ? connection.docker_ip : undefined;
  const port = typeof connection.docker_port === 'string' ? connection.docker_port : undefined;
  if (ip !== undefined && ip !== '' && port !== undefined && port !== '') {
    return `nc ${ip} ${port}`;
  }
  return undefined;
}

function formatQuestion(index: number, question: CompetitionQuestion): string {
  const lines: string[] = [];
  const flags = [
    `[${question.category}]`,
    `${question.score}pt`,
    `solved ${question.solvedNumber}`,
    question.isSolved ? 'SOLVED' : question.interactive ? 'interactive' : 'static',
    `id=${question.questionId}`,
  ];
  lines.push(`${index}. ${question.title}  ${flags.join(' | ')}`);
  if (question.description !== '') {
    const description = question.description.replaceAll(/\s+/g, ' ').trim();
    const preview =
      description.length > DESCRIPTION_PREVIEW_CHARS
        ? `${description.slice(0, DESCRIPTION_PREVIEW_CHARS)}…`
        : description;
    lines.push(`   ${preview}`);
  }
  if (question.fileUrl !== '') {
    lines.push(`   attachment: ${question.fileUrl}`);
  }
  const connection = formatConnection(question);
  if (connection !== undefined) {
    lines.push(`   connection: ${connection}`);
  }
  if (question.capabilities.length > 0) {
    lines.push(`   capabilities: ${question.capabilities.join(', ')}`);
  }
  return lines.join('\n');
}

function toErrorResult(error: unknown, action: string): { output: string; isError: true } {
  if (error instanceof CompetitionApiError) {
    return errorResult(`${action} failed: ${error.message}`);
  }
  return errorResult(`${action} failed: ${errorMessage(error)}`);
}

const listQuestionsTool = (client: CompetitionClient): Tool =>
  defineTool({
    name: 'competition_list',
    description:
      'List all challenges of the CTF competition platform: id, title, category, score, solve count, ' +
      'description, attachment URL and container connection info. ' +
      'Call it first to pick a target and to obtain the questionId required by competition_reset / competition_submit; ' +
      'call it again anytime to re-check solve status.',
    inputSchema: z.object({}),
    isReadOnly: () => true,
    accesses: () => [{ kind: 'read' }],
    describeCall: () => 'List competition questions',
    call: async (_input, ctx) => {
      try {
        const questions = await client.listQuestions(ctx.signal);
        if (questions.length === 0) {
          return { output: 'No questions available on the platform.' };
        }
        const text = questions.map((q, i) => formatQuestion(i + 1, q)).join('\n');
        return { output: truncate(text, MAX_OUTPUT_CHARS, '\n[Question list truncated]') };
      } catch (error) {
        return toErrorResult(error, 'Listing questions');
      }
    },
  });

const resetEnvironmentTool = (client: CompetitionClient): Tool =>
  defineTool({
    name: 'competition_reset',
    description:
      'Reset the container environment of an interactive (docker) question, e.g. after you crashed or ' +
      'corrupted the remote service. Only container questions support reset; questionId comes from competition_list. ' +
      'The container may take a few seconds to come back — reconnect after resetting.',
    inputSchema: z.object({
      questionId: z.string().min(1).describe('The question_id of the target question'),
    }),
    describeCall: (input) => `Reset environment of question ${input.questionId}`,
    call: async (input, ctx) => {
      try {
        const message = await client.resetEnvironment(input.questionId, ctx.signal);
        return { output: `Environment reset requested for ${input.questionId}: ${message}` };
      } catch (error) {
        return toErrorResult(error, `Resetting environment of ${input.questionId}`);
      }
    },
  });

const submitFlagTool = (client: CompetitionClient): Tool =>
  defineTool({
    name: 'competition_submit',
    description:
      'Submit a captured flag for a question. questionId comes from competition_list; flag is the exact ' +
      'string you captured. The result tells you whether the flag is correct — if incorrect, keep ' +
      'investigating instead of repeating the same flag.',
    inputSchema: z.object({
      questionId: z.string().min(1).describe('The question_id of the target question'),
      flag: z.string().min(1).describe('The captured flag content, submitted verbatim'),
    }),
    describeCall: (input) => `Submit flag for ${input.questionId}`,
    call: async (input, ctx) => {
      try {
        const outcome = await client.submitFlag(input.questionId, input.flag, ctx.signal);
        if (outcome.correct) {
          return { output: `Correct! Flag accepted for ${input.questionId}. (${outcome.message})` };
        }
        return {
          output: `Incorrect flag for ${input.questionId}: ${outcome.message}. Keep investigating; do not resubmit the same flag.`,
          isError: true,
        };
      } catch (error) {
        return toErrorResult(error, `Submitting flag for ${input.questionId}`);
      }
    },
  });

/** 赛题工具三件套；仅在宿主提供 CompetitionClient（配置了队伍 token）时注册 */
export function createCompetitionTools(client: CompetitionClient): Tool[] {
  return [listQuestionsTool(client), resetEnvironmentTool(client), submitFlagTool(client)];
}
