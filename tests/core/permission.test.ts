import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PermissionMode, PermissionRule } from '#/config/schema';
import {
  ApprovalManager,
  sessionRuleFor,
  type ApprovalReply,
  type ApprovalRequest,
} from '#/core/permission/approval';
import { nextPermissionMode, permissionModeMeta } from '#/core/permission/modes';
import { evaluatePermission, type PermissionContext } from '#/core/permission/pipeline';
import { describeRule, findMatchingRule, matchRule } from '#/core/permission/rules';
import { TaskManager } from '#/core/tasks';
import { createBashTool } from '#/core/tools/builtin/bash';
import { readTool } from '#/core/tools/builtin/read';
import { writeTool } from '#/core/tools/builtin/write';

const cwd = process.cwd();

// 权限判定只看工具名/accesses/describeCall，不需要真正的任务管理器
const bashTool = createBashTool(new TaskManager());

function makeCtx(overrides?: Partial<PermissionContext>): PermissionContext {
  return { mode: 'default', rules: [], sessionApprovals: [], cwd, ...overrides };
}

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'call_0',
    toolName: 'bash',
    describeCall: 'Bash git status',
    input: { command: 'git status' },
    reason: '需要确认',
    ...overrides,
  };
}

describe('nextPermissionMode', () => {
  it('按 default → acceptEdits → plan → bypassPermissions → default 循环', () => {
    let mode: PermissionMode = 'default';
    const seen: PermissionMode[] = [mode];
    for (let i = 0; i < 4; i += 1) {
      mode = nextPermissionMode(mode);
      seen.push(mode);
    }
    expect(seen).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'default']);
  });

  it('四种模式都有展示元数据', () => {
    const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
    for (const mode of modes) {
      expect(permissionModeMeta[mode].label).not.toBe('');
      expect(permissionModeMeta[mode].symbol).not.toBe('');
      expect(permissionModeMeta[mode].color).not.toBe('');
    }
  });
});

describe('matchRule', () => {
  it('无 pattern 匹配该工具全部调用', () => {
    const rule: PermissionRule = { action: 'allow', tool: 'Bash' };
    expect(matchRule(rule, 'bash', { command: 'rm -rf /' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', '非对象 input', cwd)).toBe(true);
    expect(matchRule(rule, 'write', { path: 'a.ts' }, cwd)).toBe(false);
  });

  it('tool 名大小写不敏感', () => {
    expect(matchRule({ action: 'allow', tool: 'BASH' }, 'bash', { command: 'x' }, cwd)).toBe(true);
  });

  it('bash 前缀 glob：git * 匹配 git 开头的命令与裸 git', () => {
    const rule: PermissionRule = { action: 'allow', tool: 'Bash', pattern: 'git *' };
    expect(matchRule(rule, 'bash', { command: 'git status' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'git push origin main' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'git' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'gitk' }, cwd)).toBe(false);
    expect(matchRule(rule, 'bash', { command: 'gitx status' }, cwd)).toBe(false);
  });

  it('bash 精确 pattern 只匹配该命令本身', () => {
    const rule: PermissionRule = { action: 'allow', tool: 'Bash', pattern: 'git status' };
    expect(matchRule(rule, 'bash', { command: 'git status' }, cwd)).toBe(true);
    expect(matchRule(rule, 'bash', { command: 'git status -s' }, cwd)).toBe(false);
    expect(matchRule(rule, 'bash', { command: 'git' }, cwd)).toBe(false);
  });

  it('bash 匹配前 trim 命令首尾空白', () => {
    const rule: PermissionRule = { action: 'allow', tool: 'Bash', pattern: 'git *' };
    expect(matchRule(rule, 'bash', { command: '  git status  ' }, cwd)).toBe(true);
  });

  it('路径 glob 相对 cwd 匹配', () => {
    const rule: PermissionRule = { action: 'deny', tool: 'Write', pattern: 'src/**' };
    expect(matchRule(rule, 'write', { path: 'src/a.ts', content: '' }, cwd)).toBe(true);
    expect(matchRule(rule, 'write', { path: 'tests/a.ts', content: '' }, cwd)).toBe(false);
  });

  it('路径 glob：* 不跨目录，** 跨目录', () => {
    const star: PermissionRule = { action: 'allow', tool: 'Read', pattern: '*.ts' };
    expect(matchRule(star, 'read', { path: 'a.ts' }, cwd)).toBe(true);
    expect(matchRule(star, 'read', { path: 'src/a.ts' }, cwd)).toBe(false);
    const globstar: PermissionRule = { action: 'allow', tool: 'Read', pattern: '**/*.ts' };
    expect(matchRule(globstar, 'read', { path: 'src/a.ts' }, cwd)).toBe(true);
  });

  it('input.path 为绝对路径时按相对 cwd 匹配；规则写绝对路径也可匹配', () => {
    const absolute = path.resolve(cwd, 'src/a.ts');
    const relative: PermissionRule = { action: 'allow', tool: 'Read', pattern: 'src/**' };
    expect(matchRule(relative, 'read', { path: absolute }, cwd)).toBe(true);
    const absoluteRule: PermissionRule = {
      action: 'allow',
      tool: 'Read',
      pattern: absolute.split(path.sep).join('/'),
    };
    expect(matchRule(absoluteRule, 'read', { path: 'src/a.ts' }, cwd)).toBe(true);
  });

  it('带 pattern 的规则不匹配缺 path/command 的非法 input', () => {
    expect(matchRule({ action: 'deny', tool: 'Read', pattern: '**' }, 'read', {}, cwd)).toBe(false);
    expect(matchRule({ action: 'deny', tool: 'Bash', pattern: '*' }, 'bash', {}, cwd)).toBe(false);
  });

  it('tool 字段含 glob 元字符时按 glob 匹配工具名（MCP 工具组）', () => {
    const rule: PermissionRule = { action: 'allow', tool: 'mcp__filesystem__*' };
    expect(matchRule(rule, 'mcp__filesystem__read_file', {}, cwd)).toBe(true);
    expect(matchRule(rule, 'mcp__filesystem__write_file', {}, cwd)).toBe(true);
    expect(matchRule(rule, 'mcp__other__read_file', {}, cwd)).toBe(false);
    expect(matchRule(rule, 'read', {}, cwd)).toBe(false);
    // glob 匹配保持大小写不敏感，与精确匹配一致
    expect(matchRule({ action: 'allow', tool: 'MCP__FILESYSTEM__*' }, 'mcp__filesystem__x', {}, cwd)).toBe(true);
  });
});

describe('findMatchingRule', () => {
  it('同 action 内按数组顺序先匹配优先', () => {
    const rules: PermissionRule[] = [
      { action: 'deny', tool: 'Bash', pattern: 'rm *' },
      { action: 'deny', tool: 'Bash', pattern: 'rm -rf *' },
    ];
    const hit = findMatchingRule(rules, 'deny', 'bash', { command: 'rm -rf x' }, cwd);
    expect(describeRule(hit!)).toBe('Bash(rm *)');
  });

  it('只查找指定 action 的规则', () => {
    const rules: PermissionRule[] = [{ action: 'allow', tool: 'Bash', pattern: 'git *' }];
    expect(findMatchingRule(rules, 'deny', 'bash', { command: 'git status' }, cwd)).toBeUndefined();
  });
});

describe('evaluatePermission', () => {
  it('1. deny 规则命中 → deny，reason 带规则描述', () => {
    const decision = evaluatePermission(
      bashTool,
      { command: 'rm -rf x' },
      makeCtx({ rules: [{ action: 'deny', tool: 'Bash', pattern: 'rm *' }] }),
    );
    expect(decision).toEqual({ kind: 'deny', reason: '被 deny 规则 Bash(rm *) 拒绝' });
  });

  it('1. deny 优先级最高：bypassPermissions 也不能越过', () => {
    const rules: PermissionRule[] = [{ action: 'deny', tool: 'Bash', pattern: 'rm *' }];
    const decision = evaluatePermission(
      bashTool,
      { command: 'rm x' },
      makeCtx({ mode: 'bypassPermissions', rules }),
    );
    expect(decision.kind).toBe('deny');
  });

  it('1. deny > allow：与数组顺序无关', () => {
    const rules: PermissionRule[] = [
      { action: 'allow', tool: 'Bash', pattern: 'rm *' },
      { action: 'deny', tool: 'Bash', pattern: 'rm *' },
    ];
    const decision = evaluatePermission(bashTool, { command: 'rm x' }, makeCtx({ rules }));
    expect(decision.kind).toBe('deny');
  });

  it('2. plan 模式拒绝写/执行，reason 说明只读', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: 'a.ts', content: 'x' },
      makeCtx({ mode: 'plan' }),
    );
    expect(decision.kind).toBe('deny');
    expect(decision.kind === 'deny' && decision.reason).toContain('plan');
  });

  it('2. plan 模式放行只读工具', () => {
    const decision = evaluatePermission(readTool, { path: 'a.ts' }, makeCtx({ mode: 'plan' }));
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('3. bypassPermissions 放行 bash', () => {
    const decision = evaluatePermission(
      bashTool,
      { command: 'rm -rf x' },
      makeCtx({ mode: 'bypassPermissions' }),
    );
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('4. ask 规则命中 → ask，reason 带规则描述', () => {
    const decision = evaluatePermission(
      bashTool,
      { command: 'sudo apt update' },
      makeCtx({ rules: [{ action: 'ask', tool: 'Bash', pattern: 'sudo *' }] }),
    );
    expect(decision).toEqual({ kind: 'ask', reason: '规则 Bash(sudo *) 要求用户确认' });
  });

  it('5. acceptEdits 放行文件写，bash 仍落到兜底 ask', () => {
    const write = evaluatePermission(
      writeTool,
      { path: 'a.ts', content: 'x' },
      makeCtx({ mode: 'acceptEdits' }),
    );
    expect(write).toEqual({ kind: 'allow' });
    const bash = evaluatePermission(
      bashTool,
      { command: 'ls' },
      makeCtx({ mode: 'acceptEdits' }),
    );
    expect(bash.kind).toBe('ask');
  });

  it('6. allow 规则命中 → allow', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: 'docs/a.md', content: 'x' },
      makeCtx({ rules: [{ action: 'allow', tool: 'Write', pattern: 'docs/**' }] }),
    );
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('7. 会话级审批缓存命中 → allow', () => {
    const decision = evaluatePermission(
      bashTool,
      { command: 'git push' },
      makeCtx({ sessionApprovals: [{ action: 'allow', tool: 'Bash', pattern: 'git *' }] }),
    );
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('8. 只读工具 → allow', () => {
    const decision = evaluatePermission(readTool, { path: 'a.ts' }, makeCtx());
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('9. 兜底 → ask', () => {
    const decision = evaluatePermission(bashTool, { command: 'ls' }, makeCtx());
    expect(decision.kind).toBe('ask');
  });
});

describe('sessionRuleFor', () => {
  it('bash 取命令首词：git status → Bash(git *)', () => {
    expect(sessionRuleFor(makeRequest(), cwd)).toEqual({
      action: 'allow',
      tool: 'Bash',
      pattern: 'git *',
    });
  });

  it('bash 裸命令 git → Bash(git *)，同样覆盖 git 本身', () => {
    const rule = sessionRuleFor(makeRequest({ input: { command: 'git' } }), cwd);
    expect(rule).toEqual({ action: 'allow', tool: 'Bash', pattern: 'git *' });
    expect(matchRule(rule, 'bash', { command: 'git' }, cwd)).toBe(true);
  });

  it('bash 空命令退化为整条 Bash 规则', () => {
    expect(sessionRuleFor(makeRequest({ input: { command: '   ' } }), cwd)).toEqual({
      action: 'allow',
      tool: 'Bash',
    });
  });

  it('write/edit 按文件路径粒度（相对 cwd）', () => {
    expect(
      sessionRuleFor(makeRequest({ toolName: 'write', input: { path: 'src/a.ts' } }), cwd),
    ).toEqual({ action: 'allow', tool: 'Write', pattern: 'src/a.ts' });
    expect(
      sessionRuleFor(
        makeRequest({ toolName: 'edit', input: { path: path.resolve(cwd, 'src/b.ts') } }),
        cwd,
      ),
    ).toEqual({ action: 'allow', tool: 'Edit', pattern: 'src/b.ts' });
  });

  it('其他工具按工具名粒度', () => {
    expect(sessionRuleFor(makeRequest({ toolName: 'slow', input: {} }), cwd)).toEqual({
      action: 'allow',
      tool: 'slow',
    });
  });
});

describe('ApprovalManager', () => {
  it('request 挂起，reply 兑现', async () => {
    const manager = new ApprovalManager(cwd);
    const promise = manager.request(makeRequest());
    expect(manager.pendingCount).toBe(1);

    let settled: ApprovalReply | null = null;
    void promise.then((reply) => {
      settled = reply;
    });
    await Promise.resolve();
    expect(settled).toBeNull();

    expect(manager.reply('call_0', { decision: 'once' })).toBe(true);
    await expect(promise).resolves.toEqual({ decision: 'once' });
    expect(manager.pendingCount).toBe(0);
  });

  it('reply 未知 id 返回 false', () => {
    const manager = new ApprovalManager(cwd);
    expect(manager.reply('nope', { decision: 'once' })).toBe(false);
  });

  it('always 写入会话规则：同首词命令不再 ask，其它命令仍 ask', async () => {
    const manager = new ApprovalManager(cwd);
    const promise = manager.request(makeRequest());
    manager.reply('call_0', { decision: 'always' });
    await promise;

    const rules = manager.getSessionApprovals();
    expect(rules).toEqual([{ action: 'allow', tool: 'Bash', pattern: 'git *' }]);
    const ctx = makeCtx({ sessionApprovals: rules });
    expect(evaluatePermission(bashTool, { command: 'git push' }, ctx)).toEqual({ kind: 'allow' });
    expect(evaluatePermission(bashTool, { command: 'rm x' }, ctx).kind).toBe('ask');
  });

  it('always 对 write 按文件路径生效', async () => {
    const manager = new ApprovalManager(cwd);
    const promise = manager.request(
      makeRequest({ toolName: 'write', input: { path: 'src/a.ts', content: 'x' } }),
    );
    manager.reply('call_0', { decision: 'always' });
    await promise;

    const ctx = makeCtx({ sessionApprovals: manager.getSessionApprovals() });
    expect(evaluatePermission(writeTool, { path: 'src/a.ts', content: 'y' }, ctx)).toEqual({
      kind: 'allow',
    });
    expect(evaluatePermission(writeTool, { path: 'src/b.ts', content: 'y' }, ctx).kind).toBe('ask');
  });

  it('重复 id 的 request 立即 reject，原请求保持挂起', async () => {
    const manager = new ApprovalManager(cwd);
    const first = manager.request(makeRequest());
    const second = manager.request(makeRequest());
    await expect(second).resolves.toMatchObject({ decision: 'reject' });
    expect(manager.pendingCount).toBe(1);
    manager.reply('call_0', { decision: 'once' });
    await expect(first).resolves.toEqual({ decision: 'once' });
  });

  it('rejectAll 以 reject 兑现所有挂起请求', async () => {
    const manager = new ApprovalManager(cwd);
    const first = manager.request(makeRequest({ id: 'a' }));
    const second = manager.request(makeRequest({ id: 'b' }));

    manager.rejectAll('interrupted by user');

    await expect(first).resolves.toEqual({ decision: 'reject', feedback: 'interrupted by user' });
    await expect(second).resolves.toEqual({ decision: 'reject', feedback: 'interrupted by user' });
    expect(manager.pendingCount).toBe(0);
  });
});
