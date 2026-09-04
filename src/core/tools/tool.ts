import { z } from 'zod';

import type { ToolDefinition } from '#/provider/types';

/**
 * 一次工具调用声明的资源访问，供调度（并发冲突判定）与 M3 权限使用。
 * read 之间互不冲突；write/execute 与任何访问冲突。
 */
export type ToolAccess =
  | { kind: 'read' }
  | { kind: 'write'; paths?: string[] }
  | { kind: 'execute' };

export function accessesConflict(left: ToolAccess[], right: ToolAccess[]): boolean {
  return left.some((a) => right.some((b) => a.kind !== 'read' || b.kind !== 'read'));
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

/**
 * input 在接口边界上是 unknown：调度方只做 JSON 语法解析，
 * schema 校验由 defineTool 的包装层在进入实现前完成。
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  /** 工具本身即用户交互（如 ask_user 提问）：权限流水线在 deny 规则后直接放行，不再弹审批 */
  readonly interactive?: boolean;
  isReadOnly(input: unknown): boolean;
  accesses(input: unknown): ToolAccess[];
  /** 一句话描述本次调用，给 UI 用；input 不合法时回退为工具名 */
  describeCall(input: unknown): string;
  call(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  toJSONSchema(): ToolDefinition;
}

export interface ToolSpec<Schema extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: Schema;
  /** 默认未声明（按普通工具走权限流水线） */
  interactive?: boolean;
  /** 默认 false（按写处理，串行调度） */
  isReadOnly?: (input: z.output<Schema>) => boolean;
  /** 默认 [{ kind: 'execute' }]（与一切冲突） */
  accesses?: (input: z.output<Schema>) => ToolAccess[];
  describeCall?: (input: z.output<Schema>) => string;
  call: (input: z.output<Schema>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<Schema extends z.ZodType>(
  def: ToolSpec<Schema>,
): Tool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.interactive === true ? { interactive: true } : {}),
    isReadOnly: (input) => {
      const parsed = def.inputSchema.safeParse(input);
      if (!parsed.success) {
        return false;
      }
      return def.isReadOnly?.(parsed.data) ?? false;
    },
    accesses: (input) => {
      const parsed = def.inputSchema.safeParse(input);
      if (!parsed.success) {
        return [{ kind: 'execute' }];
      }
      return def.accesses?.(parsed.data) ?? [{ kind: 'execute' }];
    },
    describeCall: (input) => {
      const parsed = def.inputSchema.safeParse(input);
      if (!parsed.success || def.describeCall === undefined) {
        return def.name;
      }
      return def.describeCall(parsed.data);
    },
    call: (input, ctx) => def.call(def.inputSchema.parse(input), ctx),
    toJSONSchema: () => ({
      name: def.name,
      description: def.description,
      parameters: z.toJSONSchema(def.inputSchema) as Record<string, unknown>,
    }),
  };
}
