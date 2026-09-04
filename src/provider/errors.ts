export const CONTEXT_OVERFLOW_CODE = 'context-overflow';

/** prompt 超出模型上下文限制；loop 层识别后触发响应式压缩重试 */
export class ContextOverflowError extends Error {
  readonly code = CONTEXT_OVERFLOW_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContextOverflowError';
  }
}

/** 判定错误是否为上下文溢出（duck-type 兼容自定义 provider 直接抛带 code 标记的错误） */
export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ContextOverflowError) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === CONTEXT_OVERFLOW_CODE
  );
}
