/**
 * 常见模型的上下文窗口近似注册表：仅在未显式配置 maxContextTokens 时用作自动
 * 压缩阈值基数。数值为公开文档的近似值，宁小勿大——偏小只是早压缩，偏大要先
 * 溢出再被动压缩。未收录模型回落 DEFAULT_MAX_CONTEXT_TOKENS（100k）。
 */
const ENTRIES: Array<[prefix: string, contextWindow: number]> = [
  ['gpt-5.1', 400_000],
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 128_000],
  ['o4-mini', 200_000],
  ['o3', 200_000],
  ['o1', 200_000],
  ['claude-opus-4', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-3-7', 200_000],
  ['claude-3-5', 200_000],
  ['claude-3-haiku', 200_000],
  ['kimi-k2', 256_000],
  ['kimi', 128_000],
  ['deepseek', 128_000],
  ['glm-4.6', 200_000],
  ['glm-4', 128_000],
  ['glm', 128_000],
  ['qwen3', 256_000],
  ['qwen', 128_000],
  ['gemini-2.5-pro', 1_000_000],
  ['gemini', 1_000_000],
  ['llama', 128_000],
];

/** 前缀匹配（大小写不敏感），取最长命中前缀的窗口；未收录返回 null */
export function lookupModelContextWindow(model: string): number | null {
  const needle = model.toLowerCase();
  let best: number | null = null;
  let bestLength = -1;
  for (const [prefix, contextWindow] of ENTRIES) {
    if (prefix.length > bestLength && needle.startsWith(prefix)) {
      best = contextWindow;
      bestLength = prefix.length;
    }
  }
  return best;
}
