import { z } from 'zod';

import { errorMessage } from '#/core/errors';

import { defineTool } from '../tool';

import { errorResult } from './fs-utils';
import {
  decodeEntities,
  DEFAULT_WEB_TIMEOUT_MS,
  isTimeoutError,
  webGet,
  type WebRequestOptions,
} from './web-utils';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const DEFAULT_BASE_URL = 'https://lite.duckduckgo.com';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DuckDuckGoSearchOptions extends WebRequestOptions {
  /** 测试注入用：替换 DDG lite 端点，不暴露在工具 schema 里 */
  baseUrl?: string;
}

function extractAttr(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(attrs);
  if (match === null) {
    return undefined;
  }
  return match[1] ?? match[2] ?? match[3];
}

function inlineText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 结果链接是 /l/?uddg=<真实URL> 跳转；取 uddg 参数还原，拿不到就用原 href */
function resolveResultUrl(href: string): string {
  const queryIndex = href.indexOf('?');
  if (queryIndex >= 0) {
    const uddg = new URLSearchParams(href.slice(queryIndex + 1)).get('uddg');
    if (uddg !== null && uddg !== '') {
      return uddg;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

/**
 * DDG lite 是 table 布局：每个结果一行 class=result-link 的锚点，
 * 后跟一行 class=result-snippet 的摘要。按出现顺序配对；属性顺序、
 * 引号风格、缺失摘要都容错。
 */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const links: Array<{ title: string; url: string }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1]!;
    if (!/\bresult-link\b/.test(extractAttr(attrs, 'class') ?? '')) {
      continue;
    }
    const href = extractAttr(attrs, 'href');
    if (href === undefined) {
      continue;
    }
    links.push({ title: inlineText(match[2]!), url: resolveResultUrl(decodeEntities(href)) });
  }
  const snippets: string[] = [];
  const snippetPattern =
    /<td\b[^>]*\bclass\s*=\s*(["'])[^"']*\bresult-snippet\b[^"']*\1[^>]*>([\s\S]*?)<\/td>/gi;
  for (const match of html.matchAll(snippetPattern)) {
    snippets.push(inlineText(match[2]!));
  }
  return links.map((link, index) => ({ ...link, snippet: snippets[index] ?? '' }));
}

export async function searchDuckDuckGo(
  query: string,
  options: DuckDuckGoSearchOptions = {},
): Promise<SearchResult[]> {
  const { baseUrl = DEFAULT_BASE_URL, ...request } = options;
  const response = await webGet(`${baseUrl}/lite/?q=${encodeURIComponent(query)}`, request);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  const results = parseDuckDuckGoLite(html);
  if (results.length === 0 && !/no results/i.test(html)) {
    throw new Error('未从响应中解析到搜索结果（可能确实无结果、触发限流或页面结构已变化）');
  }
  return results;
}

const inputSchema = z.object({
  query: z.string().describe('搜索查询词'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`返回结果条数，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}`),
});

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    '用 DuckDuckGo 搜索网页，返回编号结果列表（标题、链接、摘要）。' +
    '基于 DuckDuckGo lite 免 key 接口，可能受地区网络或频率限制；' +
    '拿到结果链接后可用 web_fetch 抓取页面详情。',
  inputSchema,
  isReadOnly: () => true,
  accesses: () => [{ kind: 'read' }],
  describeCall: (input) =>
    `Search "${input.query.length > 80 ? `${input.query.slice(0, 80)}…` : input.query}"`,
  call: async (input, ctx) => {
    let results: SearchResult[];
    try {
      results = await searchDuckDuckGo(input.query, { signal: ctx.signal });
    } catch (error) {
      if (ctx.signal.aborted) {
        return errorResult(`搜索被中断：${input.query}`);
      }
      if (isTimeoutError(error)) {
        return errorResult(`搜索超时（${DEFAULT_WEB_TIMEOUT_MS / 1000}s）：${input.query}`);
      }
      return errorResult(`搜索失败：${errorMessage(error)}`);
    }
    if (results.length === 0) {
      return { output: `没有找到相关结果："${input.query}"` };
    }
    const body = results
      .slice(0, input.limit ?? DEFAULT_LIMIT)
      .map((result, index) => {
        const lines = [`${index + 1}. [${result.title}](${result.url})`];
        if (result.snippet !== '') {
          lines.push(`   ${result.snippet}`);
        }
        return lines.join('\n');
      })
      .join('\n');
    return { output: body };
  },
});
