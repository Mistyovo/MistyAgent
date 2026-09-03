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
  temperature: z.number().min(0).max(2).optional(),
});

export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  provider: { type: 'openai', defaultModel: 'gpt-5-mini' },
};
