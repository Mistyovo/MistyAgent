import type { ChatParams, ChatProvider, StreamedMessagePart } from '#/provider/types';

import { isRetryableError } from '../errors';

export interface ChatWithRetryOptions {
  /** 重试次数（不含首次尝试），默认 3 */
  maxRetries?: number | undefined;
  /** 首次退避毫秒数，之后指数翻倍（1s/2s/4s），默认 1000 */
  baseDelayMs?: number | undefined;
  /** 可注入，测试用 noop 避免真实等待 */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 带指数退避重试的模型采样。可重试错误（429/5xx/网络错误）只在尚未流出
 * 任何内容 part 时重试；已流出内容后失败只能透传（重试会重复内容）。
 * provider 抛出的异常统一规整为 error part。
 */
export async function* chatWithRetry(
  provider: ChatProvider,
  params: ChatParams,
  options?: ChatWithRetryOptions,
): AsyncGenerator<StreamedMessagePart, void, unknown> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const sleep = options?.sleep ?? defaultSleep;

  let attempt = 0;
  while (true) {
    let streamedContent = false;
    let shouldRetry = false;
    try {
      for await (const part of provider.generate(params)) {
        if (part.type !== 'error') {
          streamedContent = streamedContent || (part.type !== 'done');
          yield part;
          continue;
        }
        if (
          !streamedContent &&
          attempt < maxRetries &&
          params.signal?.aborted !== true &&
          isRetryableError(part.error)
        ) {
          shouldRetry = true;
          break;
        }
        yield part;
        return;
      }
      if (!shouldRetry) {
        return;
      }
    } catch (error) {
      if (
        !streamedContent &&
        attempt < maxRetries &&
        params.signal?.aborted !== true &&
        isRetryableError(error)
      ) {
        shouldRetry = true;
      } else {
        yield { type: 'error', error };
        return;
      }
    }
    attempt += 1;
    await sleep(baseDelayMs * 2 ** (attempt - 1), params.signal);
    if (params.signal?.aborted === true) {
      return;
    }
  }
}
