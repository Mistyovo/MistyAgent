export const DEFAULT_WEB_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface WebRequestOptions {
  signal?: AbortSignal;
  /** 默认 DEFAULT_WEB_TIMEOUT_MS */
  timeoutMs?: number;
}

/** GET 请求：跟随重定向，超时信号与调用方 signal 复合 */
export async function webGet(url: string, options: WebRequestOptions = {}): Promise<Response> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS)];
  if (options.signal !== undefined) {
    signals.unshift(options.signal);
  }
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.any(signals),
    headers: { 'user-agent': USER_AGENT },
  });
}

/** AbortSignal.timeout 触发时 fetch 以 TimeoutError 拒绝；可能被包进 cause */
export function isTimeoutError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'TimeoutError'
  ) {
    return true;
  }
  return error instanceof Error && error.cause !== undefined && isTimeoutError(error.cause);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  middot: '·',
};

/** 解码常见命名实体与 &#123; / &#x1F; 数字实体；无法识别的原样保留 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') || entity.startsWith('#X')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) {
        return match;
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}
