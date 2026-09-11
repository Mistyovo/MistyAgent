import { z } from 'zod';

export const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

export const permissionRuleSchema = z.object({
  action: z.enum(['allow', 'deny', 'ask']),
  tool: z.string(),
  pattern: z.string().optional(),
});

export const hookEventSchema = z.enum(['preToolUse', 'postToolUse', 'stop']);

export const hookEntrySchema = z.object({
  /** 工具名匹配正则（preToolUse/postToolUse）；缺省匹配全部，stop 事件忽略此字段 */
  matcher: z
    .string()
    .refine(
      (pattern) => {
        try {
          RegExp(pattern);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'matcher is not a valid regular expression' },
    )
    .optional(),
  command: z.string().min(1),
});

export const hooksSettingsSchema = z.object({
  preToolUse: z.array(hookEntrySchema).optional(),
  postToolUse: z.array(hookEntrySchema).optional(),
  stop: z.array(hookEntrySchema).optional(),
});

/** MCP server 启动配置（v1 仅 stdio transport；SSE/HTTP 留扩展位） */
export const mcpServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** 在默认继承环境之上追加/覆盖的子进程环境变量 */
  env: z.record(z.string(), z.string()).optional(),
});

const providerSettingsSchema = z.object({
  type: z.literal('openai'),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  defaultModel: z.string(),
});

export const settingsSchema = z.object({
  provider: providerSettingsSchema,
  permissionMode: permissionModeSchema.optional(),
  permissionRules: z.array(permissionRuleSchema).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** 主模型失败时依次降级的备用模型链（数组在分层合并时拼接累加；仅当前 turn 生效） */
  fallbackModels: z.array(z.string().min(1)).optional(),
  /** 上下文压缩的 token 上限基数（估算超过 80% 时触发），缺省 100000 */
  maxContextTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** shell 命令钩子：工具执行前后 / turn 结束时触发（数组在分层合并时拼接累加） */
  hooks: hooksSettingsSchema.optional(),
  /** MCP servers：name → stdio 启动配置；其工具以 mcp__<server>__<tool> 名并入工具池 */
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  /** 持久记忆开关：开启后主代理可读写 ~/.misty/memory，并在每轮召回相关记忆 */
  memory: z.boolean().optional(),
});

export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type HookEvent = z.infer<typeof hookEventSchema>;
export type HookEntry = z.infer<typeof hookEntrySchema>;
export type HooksSettings = z.infer<typeof hooksSettingsSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  provider: { type: 'openai', defaultModel: 'gpt-5-mini' },
};
