/**
 * OpenAI 兼容生态中 reasoning 内容没有统一的 wire 字段名。已知的两种：
 * - `reasoning_content`：DeepSeek 的原始约定，Kimi 及多数兼容网关沿用
 * - `reasoning`：OpenAI GPT-OSS 指南、新版 vLLM
 * 按优先级顺序探测，首个字符串值生效；也可用 explicitKey 钉死字段名。
 */
export const KNOWN_REASONING_KEYS = ['reasoning_content', 'reasoning'] as const;

export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];

export interface ReasoningExtraction {
  key: string;
  value: string;
}

export function extractReasoning(
  source: unknown,
  explicitKey?: string,
): ReasoningExtraction | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      return { key, value };
    }
  }
  return undefined;
}
