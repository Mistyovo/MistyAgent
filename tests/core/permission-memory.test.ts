import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getMemoryDir } from '#/core/memory/paths';
import { evaluatePermission, type PermissionContext } from '#/core/permission/pipeline';
import { TaskManager } from '#/core/tasks';
import { createBashTool } from '#/core/tools/builtin/bash';
import { editTool } from '#/core/tools/builtin/edit';
import { writeTool } from '#/core/tools/builtin/write';

const cwd = process.cwd();
// isMemoryPath 用真实 homedir：~/.misty/memory
const memoryDir = getMemoryDir();

const bashTool = createBashTool(new TaskManager());

function makeCtx(overrides?: Partial<PermissionContext>): PermissionContext {
  return { mode: 'default', rules: [], sessionApprovals: [], cwd, ...overrides };
}

describe('evaluatePermission 记忆目录放行', () => {
  it('default 模式 write 到 ~/.misty/memory 内 → allow', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: path.join(memoryDir, 'user_role.md'), content: 'x' },
      makeCtx(),
    );
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('edit 到记忆目录内同样放行；目录外路径不受影响仍落到兜底 ask', () => {
    const edit = evaluatePermission(
      editTool,
      { path: path.join(memoryDir, 'a.md'), old_string: 'a', new_string: 'b' },
      makeCtx(),
    );
    expect(edit).toEqual({ kind: 'allow' });
    const outside = evaluatePermission(
      writeTool,
      { path: 'src/a.ts', content: 'x' },
      makeCtx(),
    );
    expect(outside.kind).toBe('ask');
  });

  it('plan 模式下记忆写入仍被拒（只读拒绝排在放行之前）', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: path.join(memoryDir, 'user_role.md'), content: 'x' },
      makeCtx({ mode: 'plan' }),
    );
    expect(decision.kind).toBe('deny');
  });

  it('deny 规则命中记忆路径仍被拒（deny 优先级最高）', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: path.join(memoryDir, 'user_role.md'), content: 'x' },
      makeCtx({ rules: [{ action: 'deny', tool: 'Write' }] }),
    );
    expect(decision.kind).toBe('deny');
  });

  it('bash 工具不受影响：写记忆路径的命令仍落到兜底 ask', () => {
    const decision = evaluatePermission(
      bashTool,
      { command: `echo x > "${path.join(memoryDir, 'a.md')}"` },
      makeCtx(),
    );
    expect(decision.kind).toBe('ask');
  });
});
