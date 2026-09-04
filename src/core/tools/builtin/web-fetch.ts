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
  url: z.string().describe('要抓取的页面 URL（http/https）'),
  prompt: z
    .string()
    .optional()
    .describe('可选：希望根据页面内容回答的问题，会附在页面文本末尾一并返回'),
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
    '抓取一个 URL 的页面内容：HTML 自动转成纯文本，text/*、JSON、XML 等文本类内容原样返回，' +
    `跟随重定向，超时 ${DEFAULT_WEB_TIMEOUT_MS / 1000}s，输出最多 ${MAX_OUTPUT_CHARS} 字符。` +
    '传入 prompt 时问题会附在页面文本后一并返回，由你基于文本直接回答（不会再调用模型）。' +
    '二进制或未知内容类型返回错误。',
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
      return errorResult(`非法 URL：${input.url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return errorResult(`仅支持 http/https URL：${input.url}`);
    }
    try {
      const response = await webGet(input.url, { signal: ctx.signal });
      if (!response.ok) {
        return errorResult(`HTTP ${response.status} ${response.statusText}：${input.url}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      const kind = classifyContent(contentType);
      if (kind === 'binary') {
        return errorResult(
          `不支持的内容类型（${contentType === '' ? '未知' : contentType}），仅支持 HTML/文本类页面：${input.url}`,
        );
      }
      const raw = decodeBody(await response.arrayBuffer(), contentType);
      const text = kind === 'html' ? htmlToText(raw) : raw;
      const body =
        text === ''
          ? '(页面无文本内容)'
          : truncate(
              text,
              MAX_OUTPUT_CHARS,
              `[页面文本过长已截断，仅保留前 ${MAX_OUTPUT_CHARS} 字符]`,
            );
      const output =
        input.prompt === undefined
          ? body
          : `${body}\n\n---\n基于以上页面内容回答：${input.prompt}`;
      return { output };
    } catch (error) {
      if (ctx.signal.aborted) {
        return errorResult(`抓取被中断：${input.url}`);
      }
      if (isTimeoutError(error)) {
        return errorResult(`抓取超时（${DEFAULT_WEB_TIMEOUT_MS / 1000}s）：${input.url}`);
      }
      return errorResult(`抓取失败：${errorMessage(error)}`);
    }
  },
});
