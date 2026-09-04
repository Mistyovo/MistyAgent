import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { Session } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { App } from '#/tui/App';
import type { PromptInputProps } from '#/tui/components/PromptInput';
import type { ChatProvider, StreamedMessagePart } from '#/provider/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const probeState = vi.hoisted(() => ({ promptRenders: 0 }));

// 渲染计数探针：memo 边界与真实组件一致（浅比较），内部委托真实实现保住输入行为。
// 探针体重跑 ⟺ App 以变化了的 props 重渲 PromptInput；流式 delta 帧应全部浅比较跳过。
vi.mock('#/tui/components/PromptInput', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#/tui/components/PromptInput')>();
  const { createElement, memo } = await import('react');
  const Real = mod.PromptInput;
  return {
    ...mod,
    PromptInput: memo(function PromptInputProbe(props: PromptInputProps) {
      probeState.promptRenders += 1;
      return createElement(Real, props);
    }),
  };
});

describe('App 流式期间的子树重渲（memo 生效）', () => {
  it('流式 delta 期间 PromptInput 不重渲（仅挂载与 busy 翻转各一次）', async () => {
    probeState.promptRenders = 0;
    // 12 个 delta 间隔 70ms（> 50ms 节流窗）：每个 delta 独占一次 App 重渲；
    // 均不带换行 → 不完整尾行退化为 spinner，不触发增量冲刷
    const provider: ChatProvider = {
      async *generate(): AsyncGenerator<StreamedMessagePart, void, unknown> {
        for (let i = 0; i < 12; i += 1) {
          yield { type: 'text-delta', text: `第${i}段` };
          await sleep(70);
        }
        yield {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
    };
    const registry = createBuiltinRegistry();
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
    });
    const { lastFrame, stdin } = render(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
    );

    expect(probeState.promptRenders).toBe(1); // 挂载
    stdin.write('go');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('go');
    });
    stdin.write('\r');
    // 流式进行中：不完整尾行 → Responding… spinner；busy false→true 带来唯一一次重渲
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Responding…');
    });
    expect(probeState.promptRenders).toBe(2);
    // 12 个 delta 帧全部 memo 跳过；turn 结束 busy true→false 再来一次
    await vi.waitFor(
      () => {
        expect(lastFrame()).toContain('第11段');
      },
      { timeout: 5000 },
    );
    expect(probeState.promptRenders).toBe(3);
  }, 15_000);
});
