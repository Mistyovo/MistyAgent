import type { PermissionMode } from '#/config/schema';

export interface PermissionModeMeta {
  /** 状态栏显示名 */
  label: string;
  /** 状态栏符号 */
  symbol: string;
  /** 颜色名，由 UI 层解释 */
  color: string;
}

/**
 * 模式语义（对齐 Claude Code）：
 * - default：写操作与命令执行需要审批
 * - acceptEdits：文件写/编辑自动放行，bash 仍需审批
 * - plan：只读模式，写/执行直接拒绝（不弹审批）
 * - bypassPermissions：全部放行，仅受 deny 规则约束
 */
export const permissionModeMeta: Record<PermissionMode, PermissionModeMeta> = {
  default: { label: 'default', symbol: '?', color: 'yellow' },
  acceptEdits: { label: 'accept edits', symbol: '⏵', color: 'cyan' },
  plan: { label: 'plan mode', symbol: '⏸', color: 'blue' },
  bypassPermissions: { label: 'bypass permissions', symbol: '⚠', color: 'red' },
};

const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** TUI shift+tab 的循环切换顺序 */
export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const index = MODE_CYCLE.indexOf(current);
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length]!;
}
