import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpServerConfig } from '#/config/schema';

import { errorMessage } from '../errors';

/** MCP server 提供的工具元数据（inputSchema 是线上透传的 JSON Schema 对象） */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const STDERR_TAIL_LIMIT = 500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${ms}ms 内未响应`));
    }, ms);
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/**
 * 单个 MCP server 的 stdio 连接封装。连接失败 / 子进程退出不抛出到会话层：
 * connect 由调用方（McpManager）降级为 warning，连接建立后的断开只影响该
 * server 自己的工具调用（callTool 快速失败，错误回喂模型）。
 */
export class McpClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private stderrTail = '';
  private closed = false;

  constructor(
    private readonly serverName: string,
    config: McpServerConfig,
    cwd: string,
  ) {
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...config.env },
      cwd,
      // 子进程 stderr 不直写上屏（会破坏 TUI 渲染区），留尾部做连接失败诊断
      stderr: 'pipe',
    });
    this.transport.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
    });
    this.client = new Client({ name: 'misty-agent', version: '0.1.0' });
    // SDK 的 Protocol 只暴露 onclose 属性赋值，没有 addEventListener
    // oxlint-disable-next-line prefer-add-event-listener
    this.client.onclose = () => {
      this.closed = true;
    };
  }

  /** 建立连接并拉取工具列表；失败时清理子进程后抛错（含 stderr 尾部诊断） */
  async connect(timeoutMs: number): Promise<McpToolInfo[]> {
    let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
    try {
      tools = await withTimeout(
        (async () => {
          await this.client.connect(this.transport);
          const result = await this.client.listTools();
          return result.tools;
        })(),
        timeoutMs,
      );
    } catch (error) {
      await this.close();
      const detail = errorMessage(error);
      const stderr = this.stderrTail.trim();
      throw new Error(
        `MCP server "${this.serverName}" 连接失败：${detail}${stderr === '' ? '' : `（stderr: ${stderr}）`}`,
        { cause: error },
      );
    }
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  isClosed(): boolean {
    return this.closed;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.client.callTool({ name, arguments: args });
    return result as CallToolResult;
  }

  /** 断开连接并终止子进程；幂等，退出路径反复调用安全 */
  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.client.close();
    } catch {
      // 退出路径兜底：关闭失败（子进程已死等）不影响主流程
    }
  }
}
