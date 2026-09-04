import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'hang-mcp', version: '0.0.1' });

// 永不回包的工具：模拟卡死的 MCP server，验证调用可中断、可超时
server.registerTool('hang', { description: '接收请求但永不返回结果', inputSchema: {} }, () => {
  return new Promise(() => {});
});

// 客户端断开（stdin 关闭）后退出，避免测试结束残留子进程
process.stdin.on('end', () => {
  process.exit(0);
});

await server.connect(new StdioServerTransport());
