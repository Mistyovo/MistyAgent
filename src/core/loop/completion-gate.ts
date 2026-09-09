import type { Message, ToolMessage } from '#/provider/types';

export interface CompletionGateInput {
  /** 本 turn 的消息切片（runTurn 入口之后追加的部分） */
  turnMessages: readonly Message[];
  /** 收官步 assistant 消息的文本 */
  finalText: string;
}

export type CompletionGateVerdict = { pass: true } | { pass: false; reminder: string };

/** 完成声明：宁可漏不可误伤，英文单词带词边界避免命中 done reading 之类叙述 */
const COMPLETION_CLAIMS: readonly RegExp[] = [
  /测试.*通过/,
  /全部通过/,
  /构建成功/,
  /编译通过/,
  /已修复/,
  /修复完成/,
  /已完成/,
  /已搞定/,
  /已解决/,
  /验证通过/,
  /all tests pass/i,
  /tests? passed/i,
  /build (?:succeeds|succeeded|passed)/i,
  /\bfixed\b/i,
  // 裸 done 是极常见的收尾词（探索后回 "done" 并非完成声明），必须带限定词
  /\b(?:all|everything|tasks?|work|implementation|changes?)\s+(?:is\s+|are\s+)?done\b/i,
];

/** 变更类工具：这些调用出现后，完成声明才需要验证证据兜底 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'bash']);

/** bash 参数里的验证命令特征；直接匹配 JSON 序列化串即可（command 字段原样在内） */
const VERIFICATION_COMMAND =
  /(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck)|\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|tsc|make|mvn|gradle|oxlint)\b/i;

const REMINDER =
  'Your conclusion claims the work is complete, but this turn contains no successful verification command (tests / build / lint, ...). ' +
  'Actually run the verification command and confirm the result first; if verification is genuinely impossible, ' +
  'state explicitly in your conclusion that it is unverified and why — do not simply declare completion.';

/**
 * 完成举证闸门（借鉴 muteki 的溯源闸门）：声明完成 + 本 turn 有变更类调用
 * + 没有任何一次成功的验证命令，三者同时成立才拦截。无变更的纯问答/只读
 * turn 一律放行，claim 正则不命中也放行。
 */
export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateVerdict {
  if (!COMPLETION_CLAIMS.some((claim) => claim.test(input.finalText))) {
    return { pass: true };
  }

  const toolResults = new Map<string, ToolMessage>();
  for (const message of input.turnMessages) {
    if (message.role === 'tool') {
      toolResults.set(message.toolCallId, message);
    }
  }

  let mutating = false;
  let verified = false;
  for (const message of input.turnMessages) {
    if (message.role !== 'assistant' || message.toolCalls === undefined) {
      continue;
    }
    for (const toolCall of message.toolCalls) {
      if (MUTATING_TOOLS.has(toolCall.name)) {
        mutating = true;
      }
      if (toolCall.name === 'bash' && VERIFICATION_COMMAND.test(toolCall.arguments)) {
        const result = toolResults.get(toolCall.id);
        if (result !== undefined && result.isError !== true) {
          verified = true;
        }
      }
    }
  }

  if (!mutating || verified) {
    return { pass: true };
  }
  return { pass: false, reminder: REMINDER };
}
