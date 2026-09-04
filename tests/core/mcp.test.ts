import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { settingsSchema, type McpServerConfig } from '#/config/schema';
import { McpClient } from '#/core/mcp/client';
import { McpManager } from '#/core/mcp/manager';
import { adaptMcpTool } from '#/core/mcp/tool-adapter';
import { evaluatePermission, type PermissionContext } from '#/core/permission/pipeline';
import { Session } from '#/core/session/session';
import type { Tool } from '#/core/tools/tool';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

const cwd = process.cwd();
const fixturePath = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url));

const fakeServer: McpServerConfig = { command: process.execPath, args: [fixturePath] };

/** 真实拉起子进程的用例给足超时（Windows 上 node 启动较慢） */
const SPAWN_TIMEOUT = 30_000;

async function connectFakeManager(
  servers: Record<string, McpServerConfig> = { fake: fakeServer },
): Promise<McpManager> {
  const manager = new McpManager(servers, cwd);
  const warnings = await manager.connect();
  expect(warnings).toEqual([]);
  return manager;
}

function permissionCtx(overrides?: Partial<PermissionContext>): PermissionContext {
  return { mode: 'default', rules: [], sessionApprovals: [], cwd, ...overrides };
}

/** 不经真实 server 的适配工具（纯适配层/权限用例） */
function stubTool(info?: Partial<{ server: string; name: string; description: string }>): Tool {
  const client = {
    callTool: async () => ({ content: [{ type: 'text', text: 'stubbed' }] }),
  } as unknown as McpClient;
  return adaptMcpTool(info?.server ?? 'fake', client, {
    name: info?.name ?? 'echo',
    description: info?.description ?? '',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  });
}

describe('mcpServers 配置', () => {
  it('schema 接受 mcpServers 并深合并友好', () => {
    const parsed = settingsSchema.parse({
      provider: { type: 'openai', defaultModel: 'm' },
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { FOO: 'bar' },
        },
      },
    });
    expect(parsed.mcpServers?.filesystem?.command).toBe('npx');
    expect(parsed.mcpServers?.filesystem?.env).toEqual({ FOO: 'bar' });
  });

  it('command 为空串时校验失败', () => {
    const result = settingsSchema.safeParse({
      provider: { type: 'openai', defaultModel: 'm' },
      mcpServers: { bad: { command: '' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('MCP tool 适配层', () => {
  it('工具名加 mcp__<server>__<tool> 前缀，describeCall 为 MCP server:tool', () => {
    const tool = stubTool({ server: 'filesystem', name: 'read_file' });
    expect(tool.name).toBe('mcp__filesystem__read_file');
    expect(tool.describeCall({})).toBe('MCP filesystem:read_file');
    expect(tool.describeCall('非法 input')).toBe('MCP filesystem:read_file');
  });

  it('description 缺省时回退为占位文案', () => {
    expect(stubTool().description).toBe('MCP 工具 fake:echo');
    expect(stubTool({ description: '回显' }).description).toBe('回显');
  });

  it('toJSONSchema 透传 MCP server 给的原始 JSON Schema', () => {
    const definition = stubTool().toJSONSchema();
    expect(definition.name).toBe('mcp__fake__echo');
    expect(definition.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  });

  it('保守权限标记：非只读、execute 访问', () => {
    const tool = stubTool();
    expect(tool.isReadOnly({})).toBe(false);
    expect(tool.accesses({})).toEqual([{ kind: 'execute' }]);
  });

  it('参数不是对象时直接回 isError 结果，不触达 server', async () => {
    const tool = stubTool();
    const result = await tool.call('不是对象', { cwd, signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('JSON 对象');
  });
});

describe('MCP 工具权限判定', () => {
  const tool = stubTool({ server: 'fake', name: 'echo' });

  it('default 模式兜底弹审批', () => {
    const decision = evaluatePermission(tool, { text: 'x' }, permissionCtx());
    expect(decision.kind).toBe('ask');
  });

  it('permissionRules 精确工具名 allow 放行', () => {
    const decision = evaluatePermission(
      tool,
      { text: 'x' },
      permissionCtx({ rules: [{ action: 'allow', tool: 'mcp__fake__echo' }] }),
    );
    expect(decision.kind).toBe('allow');
  });

  it('permissionRules 支持 mcp__fake__* 形式的工具名 glob', () => {
    const decision = evaluatePermission(
      tool,
      { text: 'x' },
      permissionCtx({ rules: [{ action: 'allow', tool: 'mcp__fake__*' }] }),
    );
    expect(decision.kind).toBe('allow');
    // glob 不误伤其他 server
    const other = evaluatePermission(
      stubTool({ server: 'other', name: 'echo' }),
      { text: 'x' },
      permissionCtx({ rules: [{ action: 'allow', tool: 'mcp__fake__*' }] }),
    );
    expect(other.kind).toBe('ask');
  });

  it('deny 规则仍可拦截 MCP 工具', () => {
    const decision = evaluatePermission(
      tool,
      { text: 'x' },
      permissionCtx({ rules: [{ action: 'deny', tool: 'mcp__fake__echo' }] }),
    );
    expect(decision.kind).toBe('deny');
  });

  it('plan 模式拒绝 MCP 工具（execute 访问）', () => {
    const decision = evaluatePermission(tool, { text: 'x' }, permissionCtx({ mode: 'plan' }));
    expect(decision.kind).toBe('deny');
  });
});

describe('McpManager 真实 stdio server', () => {
  it(
    '连接后工具并入工具池：前缀名、schema 透传、callTool 执行',
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const manager = await connectFakeManager();
      try {
        const tools = manager.tools();
        expect(tools.map((tool) => tool.name).toSorted()).toEqual([
          'mcp__fake__echo',
          'mcp__fake__env',
          'mcp__fake__fail',
        ]);

        const echo = tools.find((tool) => tool.name === 'mcp__fake__echo')!;
        const definition = echo.toJSONSchema();
        expect(definition.parameters).toMatchObject({
          type: 'object',
          properties: { text: { type: 'string' } },
        });

        const result = await echo.call(
          { text: 'hello mcp' },
          { cwd, signal: new AbortController().signal },
        );
        expect(result.isError).toBeUndefined();
        expect(result.output).toBe('echo: hello mcp');

        const statuses = manager.serverStatuses();
        expect(statuses).toEqual([{ name: 'fake', state: 'connected', toolCount: 3 }]);
      } finally {
        await manager.close();
      }
      expect(manager.serverStatuses()[0]?.state).toBe('disconnected');
    },
  );

  it(
    'isError 结果透传为 ToolResult.isError',
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const manager = await connectFakeManager();
      try {
        const fail = manager.tools().find((tool) => tool.name === 'mcp__fake__fail')!;
        const result = await fail.call({}, { cwd, signal: new AbortController().signal });
        expect(result.isError).toBe(true);
        expect(result.output).toBe('boom');
      } finally {
        await manager.close();
      }
    },
  );

  it(
    'server 配置 env 传入子进程环境',
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const manager = await connectFakeManager({
        fake: { ...fakeServer, env: { MISTY_MCP_TEST: 'from-config' } },
      });
      try {
        const env = manager.tools().find((tool) => tool.name === 'mcp__fake__env')!;
        const result = await env.call(
          { name: 'MISTY_MCP_TEST' },
          { cwd, signal: new AbortController().signal },
        );
        expect(result.output).toBe('from-config');
      } finally {
        await manager.close();
      }
    },
  );

  it(
    'Session 集成：模型发起 MCP 工具调用，结果回喂模型',
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const manager = await connectFakeManager();
      try {
        const provider = new FakeProvider([
          toolCallStep([
            { name: 'mcp__fake__echo', arguments: JSON.stringify({ text: 'from model' }) },
          ]),
          textStep('done'),
        ]);
        const session = new Session({
          provider,
          model: 'fake-model',
          systemPrompt: 'system',
          tools: manager.tools(),
          cwd,
          permission: { mode: 'bypassPermissions' },
        });

        const result = await session.submit({ type: 'user-turn', text: 'call echo' });
        expect(result.stopReason).toBe('completed');

        expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain('mcp__fake__echo');
        const toolMessage = provider.requests[1]?.messages.find(
          (message) => message.role === 'tool',
        );
        expect(toolMessage).toMatchObject({
          role: 'tool',
          name: 'mcp__fake__echo',
          content: 'echo: from model',
        });
      } finally {
        await manager.close();
      }
    },
  );
});

describe('McpManager 降级', () => {
  it(
    '不存在的命令降级为 warning，不阻断、无工具',
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const manager = new McpManager(
        { ghost: { command: 'misty-nonexistent-command-xyz' } },
        cwd,
      );
      const warnings = await manager.connect();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('ghost');
      expect(manager.tools()).toEqual([]);
      expect(manager.serverStatuses()).toEqual([
        expect.objectContaining({ name: 'ghost', state: 'failed', toolCount: 0 }),
      ]);
      await manager.close();
    },
  );

  it(
    'server 进程立即退出时降级为 warning',
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const manager = new McpManager(
        { crasher: { command: process.execPath, args: ['-e', 'process.exit(1)'] } },
        cwd,
      );
      const warnings = await manager.connect();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('crasher');
      expect(manager.serverStatuses()[0]?.state).toBe('failed');
      await manager.close();
    },
  );

  it(
    '无响应的 server 触发连接超时',
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const manager = new McpManager(
        { silent: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } },
        cwd,
        1500,
      );
      const warnings = await manager.connect();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('silent');
      expect(warnings[0]).toContain('1500ms');
      await manager.close();
    },
  );

  it('部分失败不影响其他 server', { timeout: SPAWN_TIMEOUT }, async () => {
    const manager = new McpManager(
      { fake: fakeServer, ghost: { command: 'misty-nonexistent-command-xyz' } },
      cwd,
    );
    const warnings = await manager.connect();
    expect(warnings).toHaveLength(1);
    expect(manager.tools().map((tool) => tool.name)).toContain('mcp__fake__echo');
    expect(manager.serverStatuses().map((status) => status.state)).toEqual([
      'connected',
      'failed',
    ]);
    await manager.close();
  });
});
