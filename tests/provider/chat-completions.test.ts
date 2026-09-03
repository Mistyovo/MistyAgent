import { describe, expect, it } from 'vitest';

import { collectParts } from './fake-chunks';

describe('convertChatCompletionStream', () => {
  it('文本 delta 与 done（usage/finishReason 归一化）', async () => {
    const parts = await collectParts([
      { delta: { role: 'assistant' } },
      { delta: { content: '你好' } },
      { delta: { content: '，世界' } },
      { delta: {}, finishReason: 'stop' },
      { emptyChoices: true, usage: { promptTokens: 12, completionTokens: 4 } },
    ]);

    expect(parts).toEqual([
      { type: 'text-delta', text: '你好' },
      { type: 'text-delta', text: '，世界' },
      {
        type: 'done',
        usage: { inputTokens: 12, outputTokens: 4 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      },
    ]);
  });

  it('单个 tool call：id/name 在首个 chunk，arguments 分片追加', async () => {
    const parts = await collectParts([
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } },
          ],
        },
      },
      { delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }] } },
      { delta: {}, finishReason: 'tool_calls' },
    ]);

    expect(parts).toEqual([
      { type: 'tool-call-start', index: 0, id: 'call_1', name: 'read_file' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '"src/a.ts"}' },
      {
        type: 'done',
        usage: null,
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_calls',
      },
    ]);
  });

  it('arguments 先于 name 到达时缓冲，见到 name 后按 start → delta 顺序冲出', async () => {
    const parts = await collectParts([
      { delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } },
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_9', function: { name: 'f', arguments: '1}' } }],
        },
      },
      { delta: {}, finishReason: 'tool_calls' },
    ]);

    expect(parts).toEqual([
      { type: 'tool-call-start', index: 0, id: 'call_9', name: 'f' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '{"a":1}' },
      {
        type: 'done',
        usage: null,
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_calls',
      },
    ]);
  });

  it('多个并行 tool call 交错时按 index 路由', async () => {
    const parts = await collectParts([
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'c1', function: { name: 'read', arguments: '{"x":' } },
            { index: 1, id: 'c2', function: { name: 'write', arguments: '{"y":' } },
          ],
        },
      },
      {
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '1}' } },
            { index: 1, function: { arguments: '2}' } },
          ],
        },
      },
      { delta: {}, finishReason: 'tool_calls' },
    ]);

    expect(parts).toEqual([
      { type: 'tool-call-start', index: 0, id: 'c1', name: 'read' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '{"x":' },
      { type: 'tool-call-start', index: 1, id: 'c2', name: 'write' },
      { type: 'tool-call-delta', index: 1, argumentsDelta: '{"y":' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '1}' },
      { type: 'tool-call-delta', index: 1, argumentsDelta: '2}' },
      {
        type: 'done',
        usage: null,
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_calls',
      },
    ]);
  });

  it.each([
    ['stop', 'completed'],
    ['tool_calls', 'tool-calls'],
    ['function_call', 'tool-calls'],
    ['length', 'length'],
    ['content_filter', 'content-filter'],
    ['stop_sequence', 'other'],
  ] as const)('finish_reason %s 归一化为 %s', async (raw, expected) => {
    const parts = await collectParts([{ delta: {}, finishReason: raw }]);
    expect(parts.at(-1)).toMatchObject({
      type: 'done',
      finishReason: expected,
      rawFinishReason: raw,
    });
  });

  it('流结束时未上报 finish_reason 与 usage 则均为 null', async () => {
    const parts = await collectParts([{ delta: { content: 'hi' } }]);
    expect(parts.at(-1)).toEqual({
      type: 'done',
      usage: null,
      finishReason: null,
      rawFinishReason: null,
    });
  });
});
