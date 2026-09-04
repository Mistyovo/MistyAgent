import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { htmlToText, webFetchTool } from '#/core/tools/builtin/web-fetch';
import { isTimeoutError, webGet } from '#/core/tools/builtin/web-utils';
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

function respondHtml(html: string): void {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };
}

describe('htmlToText', () => {
  it('剥 script/style、实体解码、压缩空白', () => {
    const html = [
      '<html><head><title>T&amp;C</title><style>body{color:red}</style></head>',
      '<body><script>var x = 1;</script>',
      '<h1>Hello&nbsp;World</h1><p>one</p><p>two<br>three</p>',
      '<ul><li>a</li><li>b</li></ul></body></html>',
    ].join('');
    const text = htmlToText(html);
    expect(text).toContain('T&C');
    expect(text).toContain('Hello World');
    expect(text).toContain('two\nthree');
    expect(text).toContain('- a\n- b');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('\n\n');
  });

  it('数字实体解码，未知实体原样保留', () => {
    expect(htmlToText('&#65;&#x42; &unknown;')).toBe('AB &unknown;');
  });

  it('未闭合的 script 到文件尾整体丢弃', () => {
    expect(htmlToText('<p>keep</p><script>var x = 1;')).toBe('keep');
  });
});

describe('web_fetch', () => {
  it('HTML 页面转纯文本返回', async () => {
    respondHtml('<html><body><h1>Title</h1><p>body&nbsp;text</p></body></html>');
    const result = await webFetchTool.call({ url: `${baseUrl}/page` }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('Title\nbody text');
  });

  it('JSON 等文本类内容原样返回', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a": 1}');
    };
    const result = await webFetchTool.call({ url: `${baseUrl}/data` }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('{"a": 1}');
  });

  it('非 utf-8 charset 按声明解码', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=gbk' });
      res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    };
    const result = await webFetchTool.call({ url: `${baseUrl}/gbk` }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe('中文');
  });

  it('超过 30000 字符截断并注明', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(35_000));
    };
    const result = await webFetchTool.call({ url: `${baseUrl}/long` }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('已截断');
    expect(result.output.length).toBeLessThan(31_000);
  });

  it('非 2xx 状态返回 isError', async () => {
    handler = (_req, res) => {
      res.writeHead(404, 'Not Found');
      res.end('nope');
    };
    const result = await webFetchTool.call({ url: `${baseUrl}/missing` }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('404');
  });

  it('二进制内容类型返回 isError', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50]));
    };
    const result = await webFetchTool.call({ url: `${baseUrl}/img` }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('不支持的内容类型');
  });

  it('非法与非 http(s) URL 返回 isError', async () => {
    expect((await webFetchTool.call({ url: 'not a url' }, ctx)).isError).toBe(true);
    const ftp = await webFetchTool.call({ url: 'ftp://example.com/x' }, ctx);
    expect(ftp.isError).toBe(true);
    expect(ftp.output).toContain('http/https');
  });

  it('prompt 附在页面文本后返回', async () => {
    respondHtml('<p>content here</p>');
    const result = await webFetchTool.call(
      { url: `${baseUrl}/p`, prompt: '这页讲了什么？' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('content here');
    expect(result.output).toContain('这页讲了什么？');
  });

  it('超时：webGet 在 timeoutMs 后以 TimeoutError 拒绝', async () => {
    handler = () => {};
    try {
      await webGet(`${baseUrl}/slow`, { timeoutMs: 100 });
      expect.unreachable();
    } catch (error) {
      expect(isTimeoutError(error)).toBe(true);
    }
  });

  it('abort：调用方 signal 中断抓取', async () => {
    handler = () => {};
    const controller = new AbortController();
    const pending = webFetchTool.call(
      { url: `${baseUrl}/slow` },
      { cwd: ctx.cwd, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.output).toContain('中断');
  });

  it('describeCall 展示域名+路径并截断', () => {
    expect(webFetchTool.describeCall({ url: 'https://example.com/a/b?x=1' })).toBe(
      'Fetch example.com/a/b',
    );
    const longPath = `https://example.com/${'p'.repeat(200)}`;
    const shown = webFetchTool.describeCall({ url: longPath });
    expect(shown.startsWith('Fetch example.com/pp')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual('Fetch '.length + 81);
    expect(webFetchTool.describeCall({ nope: 1 })).toBe('web_fetch');
  });

  it('isReadOnly 为 true，accesses 为 read', () => {
    expect(webFetchTool.isReadOnly({ url: 'https://example.com' })).toBe(true);
    expect(webFetchTool.accesses({ url: 'https://example.com' })).toEqual([{ kind: 'read' }]);
  });
});
