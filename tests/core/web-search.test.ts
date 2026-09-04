import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseDuckDuckGoLite,
  searchDuckDuckGo,
  webSearchTool,
} from '#/core/tools/builtin/web-search';
import type { ToolContext } from '#/core/tools/tool';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let ctx: ToolContext;

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(404);
    res.end();
  };
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  ctx = { cwd: process.cwd(), signal: new AbortController().signal };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

const FAKE_DDG_HTML = `<html><body><table>
<tr><td valign="top"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1%26b%3D2&amp;rut=abc123" class='result-link'>Example &amp; Page</a></td></tr>
<tr><td class='result-snippet'>A <b>sample</b> snippet&nbsp;text</td></tr>
<tr><td><span class='link-text'>example.com</span></td></tr>
<tr><td>&nbsp;</td></tr>
<tr><td><a href="https://direct.example.org/x" class="result-link">Direct</a></td></tr>
<tr><td class="result-snippet">second snippet</td></tr>
</table></body></html>`;

describe('parseDuckDuckGoLite', () => {
  it('解析标题/链接/摘要，uddg 跳转还原真实 URL', () => {
    expect(parseDuckDuckGoLite(FAKE_DDG_HTML)).toEqual([
      {
        title: 'Example & Page',
        url: 'https://example.com/page?a=1&b=2',
        snippet: 'A sample snippet text',
      },
      { title: 'Direct', url: 'https://direct.example.org/x', snippet: 'second snippet' },
    ]);
  });

  it('缺少摘要行时 snippet 为空', () => {
    const html = `<a href="https://a.example.com/" class="result-link">Only</a>`;
    expect(parseDuckDuckGoLite(html)).toEqual([
      { title: 'Only', url: 'https://a.example.com/', snippet: '' },
    ]);
  });

  it('没有 result-link 时返回空数组', () => {
    expect(parseDuckDuckGoLite('<html><body>garbage</body></html>')).toEqual([]);
  });
});

describe('searchDuckDuckGo', () => {
  it('从注入的 baseUrl 拉取并解析结果', async () => {
    let requestedPath = '';
    handler = (req, res) => {
      requestedPath = req.url ?? '';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(FAKE_DDG_HTML);
    };
    const results = await searchDuckDuckGo('hello world', { baseUrl });
    expect(results).toHaveLength(2);
    expect(requestedPath).toBe(`/lite/?q=${encodeURIComponent('hello world')}`);
  });

  it('非 2xx 响应抛错', async () => {
    handler = (_req, res) => {
      res.writeHead(502, 'Bad Gateway');
      res.end();
    };
    await expect(searchDuckDuckGo('x', { baseUrl })).rejects.toThrow('502');
  });

  it('响应无法解析时抛错', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>totally unexpected</body></html>');
    };
    await expect(searchDuckDuckGo('x', { baseUrl })).rejects.toThrow('未从响应中解析到搜索结果');
  });

  it('无结果页面返回空数组', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>No results.</body></html>');
    };
    await expect(searchDuckDuckGo('x', { baseUrl })).resolves.toEqual([]);
  });
});

describe('web_search', () => {
  it('describeCall 展示查询词并截断', () => {
    expect(webSearchTool.describeCall({ query: 'misty agent' })).toBe('Search "misty agent"');
    const shown = webSearchTool.describeCall({ query: 'q'.repeat(200) });
    expect(shown.length).toBeLessThanOrEqual('Search ""'.length + 81);
    expect(webSearchTool.describeCall({ nope: 1 })).toBe('web_search');
  });

  it('limit 上限 20 由 schema 约束', () => {
    expect(() => webSearchTool.call({ query: 'x', limit: 21 }, ctx)).toThrow();
  });

  it('isReadOnly 为 true，accesses 为 read', () => {
    expect(webSearchTool.isReadOnly({ query: 'x' })).toBe(true);
    expect(webSearchTool.accesses({ query: 'x' })).toEqual([{ kind: 'read' }]);
  });
});
