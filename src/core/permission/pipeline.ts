import path from 'node:path';

import type { PermissionMode, PermissionRule } from '#/config/schema';

import type { Tool } from '../tools/tool';

import { ApprovalManager } from './approval';
import { describeRule, extractPath, findMatchingRule } from './rules';
import { checkSensitivePath } from './safety';

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
 * 敏感路径安全护栏：write/edit 类工具的目标命中保护清单一律 deny，
 * 任何模式（含 bypassPermissions）与 allow 规则都不可越过。
 * v1 只管带 path 的文件工具，不解析 bash 命令内容。
 */
function sensitivePathDenial(
  tool: Tool,
  input: unknown,
  cwd: string,
): PermissionDecision | undefined {
  if (!isFileEditAccess(tool, input)) {
    return undefined;
  }
  const inputPath = extractPath(input);
  if (inputPath === null) {
    return undefined;
  }
  const absolute = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(cwd, inputPath);
  const check = checkSensitivePath(absolute);
  if (!check.sensitive) {
    return undefined;
  }
  return { kind: 'deny', reason: `受保护路径：${inputPath}（${check.reason ?? '敏感文件'}）` };
}

/**
 * 判定流水线（思路借鉴 Claude Code permissions.ts 与 codex orchestrator）：
 * 1. deny 规则命中 → deny（最高优先，任何模式都不可越过）
 * 2. 敏感路径护栏命中 → deny（对齐 Claude Code safetyCheck，bypassPermissions 也不可越过）
 * 3. 交互型工具（提问本身即用户对话）→ allow（再弹审批是循环交互；plan 模式同样放行）
 * 4. plan 模式 + 写/执行 → deny（只读模式不弹审批，直接拒绝）
 * 5. bypassPermissions → allow
 * 6. ask 规则命中 → ask
 * 7. acceptEdits + 文件写类 → allow
 * 8. allow 规则命中 → allow
 * 9. 会话级审批缓存命中 → allow
 * 10. 只读工具 → allow
 * 11. 兜底 → ask
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
  const sensitiveDeny = sensitivePathDenial(tool, input, ctx.cwd);
  if (sensitiveDeny !== undefined) {
    return sensitiveDeny;
  }
  if (tool.interactive === true) {
    return ALLOW;
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
