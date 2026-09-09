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
    throw new Error(
      'Could not parse any search results from the response (there may genuinely be no results, or the request was rate-limited, or the page structure changed)',
    );
  }
  return results;
}

const inputSchema = z.object({
  query: z.string().describe('Search query'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Number of results to return, default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}`),
});

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the web with DuckDuckGo and return a numbered result list (title, link, snippet). ' +
    'It uses the keyless DuckDuckGo lite endpoint, so regional network conditions or rate limits may apply. ' +
    'Once you have result links, use web_fetch to retrieve the page contents.',
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
        return errorResult(`Search interrupted: ${input.query}`);
      }
      if (isTimeoutError(error)) {
        return errorResult(`Search timed out (${DEFAULT_WEB_TIMEOUT_MS / 1000}s): ${input.query}`);
      }
      return errorResult(`Search failed: ${errorMessage(error)}`);
    }
    if (results.length === 0) {
      return { output: `No results found for "${input.query}"` };
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
