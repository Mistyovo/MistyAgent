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
      { message: 'matcher 不是合法正则表达式' },
    )
    .optional(),
  command: z.string().min(1),
});

export const hooksSettingsSchema = z.object({
  preToolUse: z.array(hookEntrySchema).optional(),
  postToolUse: z.array(hookEntrySchema).optional(),
  stop: z.array(hookEntrySchema).optional(),
});

const providerSettingsSchema = z.object({
  type: z.literal('openai'),
  // 安全约束：apiKey 只允许来自环境变量（MISTY_API_KEY / OPENAI_API_KEY）。
  // settings.json 中出现该字段会被 loadSettings 警告并忽略；此字段留在
  // schema 里只是因为环境变量层合并进来的值也要过同一道校验。
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  defaultModel: z.string(),
});

export const settingsSchema = z.object({
  provider: providerSettingsSchema,
  permissionMode: permissionModeSchema.optional(),
  permissionRules: z.array(permissionRuleSchema).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** 上下文压缩的 token 上限基数（估算超过 80% 时触发），缺省 100000 */
  maxContextTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** shell 命令钩子：工具执行前后 / turn 结束时触发（数组在分层合并时拼接累加） */
  hooks: hooksSettingsSchema.optional(),
});

export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type HookEvent = z.infer<typeof hookEventSchema>;
export type HookEntry = z.infer<typeof hookEntrySchema>;
export type HooksSettings = z.infer<typeof hooksSettingsSchema>;
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  provider: { type: 'openai', defaultModel: 'gpt-5-mini' },
};
