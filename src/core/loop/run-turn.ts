import type { ChatProvider, Message, TokenUsage } from '#/provider/types';

import type { EventDispatcher, TurnStopReason } from '../events';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/tool';

import { executeToolCalls } from './tool-scheduler';
import { executeStep, type StepOutcome } from './turn-step';

export interface RunTurnDeps {
  provider: ChatProvider;
  model: string;
  systemPrompt: string;
  /** 可变历史，loop 直接 append（assistant / tool / 提示消息） */
  messages: Message[];
  tools: Tool[];
  cwd: string;
  maxSteps?: number | undefined;
  signal: AbortSignal;
  dispatchEvent: EventDispatcher;
}

export interface RunTurnResult {
  stopReason: TurnStopReason;
  steps: number;
  usage: TokenUsage;
}

const DEFAULT_MAX_STEPS = 50;

function addUsage(total: TokenUsage, usage: TokenUsage | null): void {
  if (usage === null) {
    return;
  }
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

/**
 * 中断或出错时丢弃 toolCalls：流被截断后 arguments 可能不完整，
 * 留在历史里会在下一次请求触发 tool_use/tool_result 配对 400。
 */
function appendAssistantMessage(messages: Message[], outcome: StepOutcome, dropToolCalls: boolean): void {
  const toolCalls = dropToolCalls ? [] : outcome.toolCalls;
  if (outcome.text === '' && outcome.reasoning === '' && toolCalls.length === 0) {
    return;
  }
  const message: Message = { role: 'assistant', content: outcome.text };
  if (outcome.reasoning !== '') {
    message.reasoning = outcome.reasoning;
  }
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }
  messages.push(message);
}

/** 给历史里缺 tool_result 的 toolCalls 补合成 isError tool 消息，保证 wire 配对完整 */
function synthesizeMissingToolResults(messages: Message[]): void {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      answered.add(message.toolCallId);
    }
  }
  for (const message of messages) {
    if (message.role !== 'assistant' || message.toolCalls === undefined) {
      continue;
    }
    for (const toolCall of message.toolCalls) {
      if (!answered.has(toolCall.id)) {
        answered.add(toolCall.id);
        messages.push({
          role: 'tool',
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: 'interrupted by user',
          isError: true,
        });
      }
    }
  }
}

/**
 * turn 级循环：反复 executeStep 直到模型不再调用工具、达到 maxSteps
 * （注入提示消息后以无工具的最后一步收尾）或被中断。
 */
export async function runTurn(deps: RunTurnDeps): Promise<RunTurnResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const registry = new ToolRegistry();
  for (const tool of deps.tools) {
    registry.register(tool);
  }
  const definitions = registry.definitions();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;
  let finalStepForced = false;

  const finish = (stopReason: TurnStopReason): RunTurnResult => {
    deps.dispatchEvent({ type: 'turn-complete', stopReason, steps, usage });
    return { stopReason, steps, usage };
  };

  const interrupt = (): RunTurnResult => {
    synthesizeMissingToolResults(deps.messages);
    deps.dispatchEvent({ type: 'interrupted', reason: 'user' });
    return finish('interrupted');
  };

  deps.dispatchEvent({ type: 'turn-started' });

  while (true) {
    if (deps.signal.aborted) {
      return interrupt();
    }
    if (steps >= maxSteps && !finalStepForced) {
      deps.messages.push({
        role: 'user',
        content:
          `已达到最大步数限制（${maxSteps} 步）。请停止调用工具，` +
          '直接总结目前的进展与结论作为收尾。',
      });
      finalStepForced = true;
    }
    steps += 1;
    const outcome = await executeStep({
      provider: deps.provider,
      model: deps.model,
      systemPrompt: deps.systemPrompt,
      messages: deps.messages,
      tools: finalStepForced ? [] : definitions,
      step: steps,
      signal: deps.signal,
      dispatchEvent: deps.dispatchEvent,
    });
    addUsage(usage, outcome.usage);

    if (outcome.errored) {
      appendAssistantMessage(deps.messages, outcome, true);
      return finish('error');
    }
    if (deps.signal.aborted) {
      appendAssistantMessage(deps.messages, outcome, true);
      return interrupt();
    }
    appendAssistantMessage(deps.messages, outcome, false);
    if (finalStepForced || outcome.toolCalls.length === 0) {
      return finish(finalStepForced ? 'max-steps' : 'completed');
    }

    const results = await executeToolCalls(outcome.toolCalls, {
      registry,
      cwd: deps.cwd,
      signal: deps.signal,
      dispatchEvent: deps.dispatchEvent,
    });
    for (const { toolCall, result } of results) {
      const message: Message = {
        role: 'tool',
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: result.output,
      };
      if (result.isError === true) {
        message.isError = true;
      }
      deps.messages.push(message);
    }
  }
}
