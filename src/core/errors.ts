export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RETRYABLE_NETWORK_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/** 429 / 5xx / 408 与常见网络错误可重试；其余（如 400/401）不可重试 */
export function isRetryableError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) {
    return status === 429 || status === 408 || status >= 500;
  }
  if (error instanceof Error) {
    return RETRYABLE_NETWORK_PATTERN.test(error.message) || isRetryableError(error.cause);
  }
  return false;
}
