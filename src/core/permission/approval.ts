import path from 'node:path';

import type { PermissionRule } from '#/config/schema';

import { extractCommand, extractPath } from './rules';

/** 一次待用户决断的审批请求；id 等于触发它的 toolCallId */
export interface ApprovalRequest {
  id: string;
  toolName: string;
  /** 一句话描述本次调用（Tool.describeCall） */
  describeCall: string;
  input: unknown;
  /** 流水线给出的 ask 原因 */
  reason: string;
}

export interface ApprovalReply {
  decision: 'once' | 'always' | 'reject';
  /** reject 时用户附带的反馈，回喂模型 */
  feedback?: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (reply: ApprovalReply) => void;
}

function firstWord(command: string): string | null {
  const word = command.trim().split(/\s+/)[0];
  return word === undefined || word === '' ? null : word;
}

/**
 * 'always' 回复规范化成的会话级 allow 规则（对齐 Claude Code 的粒度）：
 * bash → Bash(命令首词 *)；write/edit → Write(相对 cwd 的文件路径)；其他 → 工具名
 */
export function sessionRuleFor(request: ApprovalRequest, cwd: string): PermissionRule {
  if (request.toolName === 'bash') {
    const command = extractCommand(request.input);
    const word = command === null ? null : firstWord(command);
    return word === null
      ? { action: 'allow', tool: 'Bash' }
      : { action: 'allow', tool: 'Bash', pattern: `${word} *` };
  }
  if (request.toolName === 'write' || request.toolName === 'edit') {
    const inputPath = extractPath(request.input);
    if (inputPath !== null) {
      const absolute = path.isAbsolute(inputPath)
        ? path.normalize(inputPath)
        : path.resolve(cwd, inputPath);
      const relative = path.relative(cwd, absolute).split(path.sep).join('/');
      return { action: 'allow', tool: request.toolName === 'write' ? 'Write' : 'Edit', pattern: relative };
    }
  }
  return { action: 'allow', tool: request.toolName };
}

/**
 * 挂起-恢复式审批（借鉴 codex 的 pending oneshot）：request() 挂起，
 * UI 侧调 reply() 兑现；rejectAll() 在中断时清空所有挂起。
 * 'always' 回复会累积成会话级 allow 规则，供流水线第 7 步命中。
 */
export class ApprovalManager {
  private readonly cwd: string;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sessionApprovals: PermissionRule[] = [];

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  getSessionApprovals(): readonly PermissionRule[] {
    return this.sessionApprovals;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  request(request: ApprovalRequest): Promise<ApprovalReply> {
    if (this.pending.has(request.id)) {
      return Promise.resolve({ decision: 'reject', feedback: `重复的审批请求 id：${request.id}` });
    }
    return new Promise((resolve) => {
      this.pending.set(request.id, { request, resolve });
    });
  }

  /** 返回 false 表示没有该 id 的挂起请求（迟到或重复的回复） */
  reply(id: string, reply: ApprovalReply): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return false;
    }
    this.pending.delete(id);
    if (reply.decision === 'always') {
      this.sessionApprovals.push(sessionRuleFor(entry.request, this.cwd));
    }
    entry.resolve(reply);
    return true;
  }

  rejectAll(reason: string): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.resolve({ decision: 'reject', feedback: reason });
    }
  }
}
