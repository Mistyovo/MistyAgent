import type { McpServerConfig } from '#/config/schema';

import { errorMessage } from '../errors';
import type { Tool } from '../tools/tool';

import { McpClient } from './client';
import { adaptMcpTool } from './tool-adapter';

export interface McpServerStatus {
  name: string;
  state: 'connected' | 'failed' | 'disconnected';
  toolCount: number;
  error?: string;
}

interface McpEntry {
  client: McpClient;
  tools: Tool[];
  error?: string;
}

/** 单个 server 的连接总超时（含 initialize 握手与 listTools） */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

/**
 * MCP 连接管理：按配置并行连接全部 server，聚合适配后的工具。
 * 连接失败/超时降级为 warning，不阻断会话启动；close() 断开全部连接并
 * 终止子进程（Session 关闭 / 进程退出路径调用，防止子进程泄漏）。
 */
export class McpManager {
  private readonly entries = new Map<string, McpEntry>();

  constructor(
    private readonly configs: Record<string, McpServerConfig>,
    private readonly cwd: string,
    private readonly connectTimeoutMs: number = MCP_CONNECT_TIMEOUT_MS,
  ) {}

  /** 并行连接所有 server（单个 connectTimeoutMs 超时）；返回降级 warning 列表，不抛出 */
  async connect(): Promise<string[]> {
    const warnings: string[] = [];
    await Promise.all(
      Object.entries(this.configs).map(async ([name, config]) => {
        const client = new McpClient(name, config, this.cwd);
        try {
          const tools = await client.connect(this.connectTimeoutMs);
          this.entries.set(name, {
            client,
            tools: tools.map((info) => adaptMcpTool(name, client, info)),
          });
        } catch (error) {
          this.entries.set(name, { client, tools: [], error: errorMessage(error) });
          warnings.push(errorMessage(error));
        }
      }),
    );
    return warnings;
  }

  /** 全部已连接 server 的适配工具（Session 创建前注册进 registry） */
  tools(): Tool[] {
    return [...this.entries.values()].flatMap((entry) => entry.tools);
  }

  /** /mcp 展示用：按配置顺序汇报每个 server 的连接状态与工具数 */
  serverStatuses(): McpServerStatus[] {
    return Object.keys(this.configs).map((name) => {
      const entry = this.entries.get(name);
      if (entry === undefined) {
        return { name, state: 'failed', toolCount: 0, error: '尚未连接' };
      }
      if (entry.error !== undefined) {
        return { name, state: 'failed', toolCount: 0, error: entry.error };
      }
      if (entry.client.isClosed()) {
        return { name, state: 'disconnected', toolCount: entry.tools.length };
      }
      return { name, state: 'connected', toolCount: entry.tools.length };
    });
  }

  /** 断开全部连接并终止子进程；幂等 */
  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.client.close()));
  }
}
