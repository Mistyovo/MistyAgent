import type {
  ChatParams,
  ChatProvider,
  Message,
  StreamedMessagePart,
  ToolDefinition,
} from '#/provider/types';

export interface RecordedRequest {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}

/** 可编程的 ChatProvider：每次 generate 消费一个预设的 part 序列 */
export class FakeProvider implements ChatProvider {
  private readonly scripts: StreamedMessagePart[][];
  readonly requests: RecordedRequest[] = [];

  constructor(scripts: StreamedMessagePart[][]) {
    this.scripts = [...scripts];
  }

  async *generate(params: ChatParams): AsyncGenerator<StreamedMessagePart, void, unknown> {
    this.requests.push({
      model: params.model,
      systemPrompt: params.systemPrompt,
      messages: structuredClone(params.messages),
      tools: params.tools,
    });
    const script = this.scripts.length > 0 ? this.scripts.shift()! : undefined;
    if (script === undefined) {
      yield { type: 'error', error: new Error('FakeProvider: 没有预设的响应') };
      return;
    }
    for (const part of script) {
      yield part;
    }
  }
}

export function textStep(
  text: string,
  usage: { inputTokens: number; outputTokens: number } | null = null,
): StreamedMessagePart[] {
  return [
    { type: 'text-delta', text },
    { type: 'done', usage, finishReason: 'completed', rawFinishReason: 'stop' },
  ];
}

export function toolCallStep(
  calls: { name: string; arguments: string; id?: string }[],
): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  calls.forEach((call, index) => {
    parts.push({ type: 'tool-call-start', index, id: call.id ?? `call_${index}`, name: call.name });
    parts.push({ type: 'tool-call-delta', index, argumentsDelta: call.arguments });
  });
  parts.push({ type: 'done', usage: null, finishReason: 'tool-calls', rawFinishReason: 'tool_calls' });
  return parts;
}
