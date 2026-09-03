import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions';

import {
  convertChatCompletionStream,
  type ConvertStreamOptions,
} from '#/provider/openai/chat-completions';
import type { StreamedMessagePart } from '#/provider/types';

export interface FakeChunkSpec {
  delta?: Record<string, unknown>;
  finishReason?: string | null;
  usage?: { promptTokens: number; completionTokens: number };
  emptyChoices?: boolean;
}

export function makeChunk(spec: FakeChunkSpec): ChatCompletionChunk {
  const choices: ChatCompletionChunk.Choice[] =
    spec.emptyChoices === true
      ? []
      : [
          {
            index: 0,
            delta: (spec.delta ?? {}) as ChatCompletionChunk.Choice.Delta,
            finish_reason: (spec.finishReason ??
              null) as ChatCompletionChunk.Choice['finish_reason'],
          },
        ];
  return {
    id: 'chatcmpl-test',
    created: 0,
    model: 'test-model',
    object: 'chat.completion.chunk',
    choices,
    usage:
      spec.usage !== undefined
        ? {
            prompt_tokens: spec.usage.promptTokens,
            completion_tokens: spec.usage.completionTokens,
            total_tokens: spec.usage.promptTokens + spec.usage.completionTokens,
          }
        : null,
  };
}

export async function collectParts(
  specs: FakeChunkSpec[],
  options?: ConvertStreamOptions,
): Promise<StreamedMessagePart[]> {
  async function* chunks(): AsyncGenerator<ChatCompletionChunk> {
    for (const spec of specs) {
      yield makeChunk(spec);
    }
  }
  const parts: StreamedMessagePart[] = [];
  for await (const part of convertChatCompletionStream(chunks(), options)) {
    parts.push(part);
  }
  return parts;
}
