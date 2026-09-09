import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { errorResult, truncate } from './fs-utils';
import {
  decodeEntities,
  DEFAULT_WEB_TIMEOUT_MS,
  isTimeoutError,
  webGet,
} from './web-utils';

const MAX_OUTPUT_CHARS = 30_000;

const inputSchema = z.object({
  url: z.string().describe('Page URL to fetch (http/https)'),
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional: a question to answer from the page content; it is appended to the page text in the result',
    ),
});

const BLOCK_TAGS =
  'p|div|tr|table|thead|tbody|ul|ol|dl|dt|dd|section|article|header|footer|nav|aside|main|figure|figcaption|blockquote|pre|form|fieldset|h[1-6]|hr';

/**
 * HTML → 纯文本：剥掉注释、script/style 等整块内容与所有标签，块级标签转成换行，
 * 实体解码后压缩空白（每行 trim、丢弃空行）。未闭合的 script/style 到文件尾整体丢弃。
 */
export function htmlToText(html: string): string {
  let text = html.replace(/\r\n?/g, '\n');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(
    /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  text = text.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*$/i, ' ');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  text = text.replace(/<br\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[\t  ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

type ContentKind = 'html' | 'text' | 'binary';

function classifyContent(contentType: string): ContentKind {
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return 'html';
  }
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  ) {
    return 'text';
  }
  return 'binary';
}

function decodeBody(buffer: ArrayBuffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

export const webFetchTool = defineTool({
  name: 'web_fetch',
  description:
    'Fetch the content of a URL: HTML is converted to plain text automatically, and textual content such as text/*, JSON, and XML is returned as-is. ' +
    `Follows redirects, times out after ${DEFAULT_WEB_TIMEOUT_MS / 1000}s, and returns at most ${MAX_OUTPUT_CHARS} characters. ` +
    'When prompt is given, the question is appended to the page text in the result and you answer it from that text yourself (no further model call is made). ' +
    'Binary or unknown content types return an error.',
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) => {
    let shown = input.url;
    try {
      const url = new URL(input.url);
      shown = `${url.host}${url.pathname}`;
    } catch {
      // 非法 URL 原样展示
    }
    return `Fetch ${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}`;
  },
  call: async (input, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return errorResult(`Invalid URL: ${input.url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return errorResult(`Only http/https URLs are supported: ${input.url}`);
    }
    try {
      const response = await webGet(input.url, { signal: ctx.signal });
      if (!response.ok) {
        return errorResult(`HTTP ${response.status} ${response.statusText}: ${input.url}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      const kind = classifyContent(contentType);
      if (kind === 'binary') {
        return errorResult(
          `Unsupported content type (${contentType === '' ? 'unknown' : contentType}); only HTML/text pages are supported: ${input.url}`,
        );
      }
      const raw = decodeBody(await response.arrayBuffer(), contentType);
      const text = kind === 'html' ? htmlToText(raw) : raw;
      const body =
        text === ''
          ? '(the page has no text content)'
          : truncate(
              text,
              MAX_OUTPUT_CHARS,
              `[Page text truncated: only the first ${MAX_OUTPUT_CHARS} characters are kept]`,
            );
      const output =
        input.prompt === undefined
          ? body
          : `${body}\n\n---\nAnswer based on the page content above: ${input.prompt}`;
      return { output };
    } catch (error) {
      if (ctx.signal.aborted) {
        return errorResult(`Fetch interrupted: ${input.url}`);
      }
      if (isTimeoutError(error)) {
        return errorResult(`Fetch timed out (${DEFAULT_WEB_TIMEOUT_MS / 1000}s): ${input.url}`);
      }
      return errorResult(`Fetch failed: ${errorMessage(error)}`);
    }
  },
});
