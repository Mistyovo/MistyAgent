import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { errorMessage } from '../errors';
import type { Tool, ToolResult } from '../tools/tool';

import { MCP_CALL_TIMEOUT_MS, type McpClient, type McpToolInfo } from './client';

/**
 * MCP 给的 inputSchema 是 JSON Schema，本地不做实参校验（真正的校验在 server 端）；
 * 此 schema 只挡"不是对象"的调用，toJSONSchema 直接透传原 schema。
 */
const passthroughSchema = z.looseObject({});

function contentItemToText(item: unknown): string {
  if (typeof item !== 'object' || item === null) {
    return String(item);
  }
  const content = item as {
    type?: unknown;
    text?: unknown;
    mimeType?: unknown;
    name?: unknown;
    uri?: unknown;
    resource?: unknown;
  };
  if (content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }
  if (content.type === 'image' || content.type === 'audio') {
    const mime = typeof content.mimeType === 'string' ? content.mimeType : 'unknown type';
    return `[${content.type} content (${mime}), display not supported yet]`;
  }
  if (content.type === 'resource_link') {
    const label = typeof content.name === 'string' ? content.name : '';
    const uri = typeof content.uri === 'string' ? ` (${content.uri})` : '';
    return `[resource link${label === '' ? '' : `: ${label}`}${uri}]`;
  }
  if (content.type === 'resource' && typeof content.resource === 'object' && content.resource !== null) {
    const resource = content.resource as { text?: unknown; uri?: unknown };
    if (typeof resource.text === 'string') {
      return resource.text;
    }
    return `[embedded resource${typeof resource.uri === 'string' ? `: ${resource.uri}` : ''}]`;
  }
  return JSON.stringify(item);
}

interface McpCallResultLike {
  content?: unknown[] | undefined;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

/** content 数组转文本：text 拼接，其余类型留占位说明；全空时回退 structuredContent */
function resultToText(result: McpCallResultLike): string {
  const parts = (result.content ?? []).map((item) => contentItemToText(item));
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.length === 0 ? '(no output)' : parts.join('\n');
}

/**
 * 把 MCP tool 适配为本地 Tool：
 * - 名字加 mcp__<server>__<tool> 前缀（Claude Code 约定，避免与内置工具冲突）
 * - isReadOnly=false / accesses=execute（保守：default 模式弹审批，可用
 *   permissionRules 按工具名或 mcp__<server>__* glob 放行）
 * - ctx.signal 透传给 SDK（Esc 中断在途调用），调用带默认超时；
 *   中断/超时落 isError 结果，绝不让 promise 挂死
 */
export function adaptMcpTool(serverName: string, client: McpClient, info: McpToolInfo): Tool {
  const name = `mcp__${serverName}__${info.name}`;
  const description =
    info.description !== '' ? info.description : `MCP tool ${serverName}:${info.name}`;
  return {
    name,
    description,
    inputSchema: passthroughSchema,
    isReadOnly: () => false,
    accesses: () => [{ kind: 'execute' }],
    describeCall: () => `MCP ${serverName}:${info.name}`,
    call: async (input, ctx): Promise<ToolResult> => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { output: 'MCP tool arguments must be a JSON object', isError: true };
      }
      try {
        const result = await client.callTool(info.name, input as Record<string, unknown>, {
          signal: ctx.signal,
        });
        return {
          output: resultToText(result),
          ...(result.isError === true ? { isError: true } : {}),
        };
      } catch (error) {
        // SDK 把 abort 也包成 RequestTimeout 编码的 McpError，中断判定须在超时之前
        if (ctx.signal.aborted) {
          return { output: `MCP tool call interrupted: ${serverName}:${info.name}`, isError: true };
        }
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          return {
            output: `MCP tool call timed out (no response in ${MCP_CALL_TIMEOUT_MS / 1000}s): ${serverName}:${info.name}`,
            isError: true,
          };
        }
        return { output: `MCP tool call failed: ${errorMessage(error)}`, isError: true };
      }
    },
    toJSONSchema: () => ({ name, description, parameters: info.inputSchema }),
  };
}
