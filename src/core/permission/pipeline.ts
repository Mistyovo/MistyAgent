import type { PermissionMode, PermissionRule } from '#/config/schema';

import type { Tool } from '../tools/tool';

import { ApprovalManager } from './approval';
import { describeRule, findMatchingRule } from './rules';

export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string };

export interface PermissionContext {
  mode: PermissionMode;
  rules: readonly PermissionRule[];
  /** 'always' 审批累积的会话级 allow 规则 */
  sessionApprovals: readonly PermissionRule[];
  /** 路径 glob 相对它匹配 */
  cwd: string;
}

/** loop 层持有的权限运行时；getContext 每次取最新值，模式可运行时切换 */
export interface PermissionRuntime {
  getContext(): PermissionContext;
  approvals: ApprovalManager;
}

/** 测试与简单嵌入方用的工厂；Session 需要可变 mode，自行组装 runtime */
export function createPermissionRuntime(init: {
  mode: PermissionMode;
  rules?: readonly PermissionRule[];
  cwd: string;
}): PermissionRuntime {
  const approvals = new ApprovalManager(init.cwd);
  return {
    getContext: () => ({
      mode: init.mode,
      rules: init.rules ?? [],
      sessionApprovals: approvals.getSessionApprovals(),
      cwd: init.cwd,
    }),
    approvals,
  };
}

const ALLOW: PermissionDecision = { kind: 'allow' };

/** 写文件但不执行命令的工具（write/edit 及同形态工具），acceptEdits 自动放行 */
function isFileEditAccess(tool: Tool, input: unknown): boolean {
  const accesses = tool.accesses(input);
  return (
    accesses.some((access) => access.kind === 'write') &&
    accesses.every((access) => access.kind !== 'execute')
  );
}

/**
 * 判定流水线（思路借鉴 Claude Code permissions.ts 与 codex orchestrator）：
 * 1. deny 规则命中 → deny（最高优先，任何模式都不可越过）
 * 2. plan 模式 + 写/执行 → deny（只读模式不弹审批，直接拒绝）
 * 3. bypassPermissions → allow
 * 4. ask 规则命中 → ask
 * 5. acceptEdits + 文件写类 → allow
 * 6. allow 规则命中 → allow
 * 7. 会话级审批缓存命中 → allow
 * 8. 只读工具 → allow
 * 9. 兜底 → ask
 */
export function evaluatePermission(
  tool: Tool,
  input: unknown,
  ctx: PermissionContext,
): PermissionDecision {
  const denyRule = findMatchingRule(ctx.rules, 'deny', tool.name, input, ctx.cwd);
  if (denyRule !== undefined) {
    return { kind: 'deny', reason: `被 deny 规则 ${describeRule(denyRule)} 拒绝` };
  }
  const readOnly = tool.accesses(input).every((access) => access.kind === 'read');
  if (ctx.mode === 'plan' && !readOnly) {
    return { kind: 'deny', reason: `plan 模式为只读：已拒绝 ${tool.name} 的写/执行操作` };
  }
  if (ctx.mode === 'bypassPermissions') {
    return ALLOW;
  }
  const askRule = findMatchingRule(ctx.rules, 'ask', tool.name, input, ctx.cwd);
  if (askRule !== undefined) {
    return { kind: 'ask', reason: `规则 ${describeRule(askRule)} 要求用户确认` };
  }
  if (ctx.mode === 'acceptEdits' && isFileEditAccess(tool, input)) {
    return ALLOW;
  }
  if (findMatchingRule(ctx.rules, 'allow', tool.name, input, ctx.cwd) !== undefined) {
    return ALLOW;
  }
  if (findMatchingRule(ctx.sessionApprovals, 'allow', tool.name, input, ctx.cwd) !== undefined) {
    return ALLOW;
  }
  if (tool.isReadOnly(input)) {
    return ALLOW;
  }
  return { kind: 'ask', reason: `${tool.name} 需要用户确认后才能执行` };
}
