import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-mcp', version: '0.0.1' });

server.registerTool(
  'echo',
  { description: '回显输入文本', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

server.registerTool(
  'env',
  { description: '读取 server 进程环境变量', inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: 'text', text: process.env[name] ?? '' }] }),
);

server.registerTool('fail', { description: '总是返回错误结果', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'boom' }],
  isError: true,
}));

// 客户端断开（stdin 关闭）后退出，避免测试结束残留子进程
process.stdin.on('end', () => {
  process.exit(0);
});

await server.connect(new StdioServerTransport());
