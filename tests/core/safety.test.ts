import { homedir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluatePermission, type PermissionContext } from '#/core/permission/pipeline';
import { checkSensitivePath } from '#/core/permission/safety';
import { TaskManager } from '#/core/tasks';
import { createBashTool } from '#/core/tools/builtin/bash';
import { editTool } from '#/core/tools/builtin/edit';
import { readTool } from '#/core/tools/builtin/read';
import { writeTool } from '#/core/tools/builtin/write';

const cwd = process.cwd();

// 权限判定只看工具名/accesses，不需要真正的任务管理器
const bashTool = createBashTool(new TaskManager());

function makeCtx(overrides?: Partial<PermissionContext>): PermissionContext {
  return { mode: 'default', rules: [], sessionApprovals: [], cwd, ...overrides };
}

const abs = (...segments: string[]): string => path.resolve(cwd, ...segments);

describe('checkSensitivePath', () => {
  it('.git/ 内一切与 .git 本身命中', () => {
    expect(checkSensitivePath(abs('.git')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('.git', 'config')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('.git', 'hooks', 'pre-commit')).sensitive).toBe(true);
  });

  it('嵌套子目录里的 .git（子模块/子仓库）同样命中', () => {
    expect(checkSensitivePath(abs('sub', '.git', 'HEAD')).sensitive).toBe(true);
  });

  it('.gitignore / .gitattributes 不误伤', () => {
    expect(checkSensitivePath(abs('.gitignore')).sensitive).toBe(false);
    expect(checkSensitivePath(abs('sub', '.gitattributes')).sensitive).toBe(false);
  });

  it('普通路径不命中', () => {
    expect(checkSensitivePath(abs('src', 'a.ts')).sensitive).toBe(false);
    expect(checkSensitivePath(abs('node_modules', '.bin', 'tsx')).sensitive).toBe(false);
    expect(checkSensitivePath(abs('my.git', 'notes.md')).sensitive).toBe(false);
  });

  it('.env 与 .env.* 命中；config.env / foo.env 不误伤（精确匹配 basename）', () => {
    expect(checkSensitivePath(abs('.env')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('.env.local')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('src', '.env.production')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('src', 'config.env')).sensitive).toBe(false);
    expect(checkSensitivePath(abs('src', 'foo.env')).sensitive).toBe(false);
  });

  it('~/.misty/projects/ 命中；用户级与项目级 settings.json 都不命中', () => {
    const transcript = path.join(homedir(), '.misty', 'projects', '-proj', 'session.jsonl');
    expect(checkSensitivePath(transcript).sensitive).toBe(true);
    expect(checkSensitivePath(path.join(homedir(), '.misty', 'settings.json')).sensitive).toBe(
      false,
    );
    expect(checkSensitivePath(abs('.misty', 'settings.json')).sensitive).toBe(false);
  });

  it('.ssh/、.gnupg/、.aws/credentials 命中', () => {
    expect(checkSensitivePath(path.join(homedir(), '.ssh', 'config')).sensitive).toBe(true);
    expect(checkSensitivePath(path.join(homedir(), '.gnupg', 'secring.gpg')).sensitive).toBe(true);
    expect(checkSensitivePath(path.join(homedir(), '.aws', 'credentials')).sensitive).toBe(true);
    expect(checkSensitivePath(path.join(homedir(), '.aws', 'config')).sensitive).toBe(false);
  });

  it('**/*.pem 与 id_rsa* / id_ed25519* 命中', () => {
    expect(checkSensitivePath(abs('certs', 'server.pem')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('keys', 'id_rsa')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('keys', 'id_rsa.pub')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('keys', 'id_ed25519_backup')).sensitive).toBe(true);
    expect(checkSensitivePath(abs('certs', 'server.pem.txt')).sensitive).toBe(false);
  });

  it('Windows：反斜杠、混合分隔符、盘符正确解析，目录名大小写不敏感', () => {
    expect(checkSensitivePath('C:\\proj\\.git\\config').sensitive).toBe(true);
    expect(checkSensitivePath('C:/proj/.git\\hooks\\pre-commit').sensitive).toBe(true);
    expect(checkSensitivePath('C:\\proj\\.GIT\\HEAD').sensitive).toBe(true);
    expect(checkSensitivePath('C:\\proj\\src\\a.ts').sensitive).toBe(false);
  });

  it('reason 说明命中的保护项', () => {
    expect(checkSensitivePath(abs('.git', 'config'))).toEqual({
      sensitive: true,
      reason: 'Git 版本库目录 .git/',
    });
    expect(checkSensitivePath(abs('.env.local'))).toEqual({
      sensitive: true,
      reason: '密钥文件 .env*',
    });
  });
});

describe('敏感路径护栏接入 pipeline', () => {
  it('bypassPermissions 写 .git/config 仍 deny，reason 说明受保护路径', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: '.git/config', content: 'x' },
      makeCtx({ mode: 'bypassPermissions' }),
    );
    expect(decision).toEqual({
      kind: 'deny',
      reason: '受保护路径：.git/config（Git 版本库目录 .git/）',
    });
  });

  it('default 模式写 .git/HEAD 同样 deny', () => {
    const decision = evaluatePermission(writeTool, { path: '.git/HEAD', content: 'x' }, makeCtx());
    expect(decision.kind).toBe('deny');
    expect(decision.kind === 'deny' && decision.reason).toContain('受保护路径');
  });

  it('edit src/.env 在 acceptEdits 下也 deny', () => {
    const decision = evaluatePermission(
      editTool,
      { path: 'src/.env', old_string: 'A=1', new_string: 'A=2' },
      makeCtx({ mode: 'acceptEdits' }),
    );
    expect(decision.kind).toBe('deny');
    expect(decision.kind === 'deny' && decision.reason).toContain('密钥文件');
  });

  it('input.path 为绝对路径同样命中', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: abs('.git', 'config'), content: 'x' },
      makeCtx({ mode: 'bypassPermissions' }),
    );
    expect(decision.kind).toBe('deny');
  });

  it('allow 规则不能覆盖护栏', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: '.git/config', content: 'x' },
      makeCtx({ rules: [{ action: 'allow', tool: 'Write', pattern: '.git/**' }] }),
    );
    expect(decision.kind).toBe('deny');
  });

  it('普通文件不误伤：bypass 下 allow，default 下仍走原流程（兜底 ask）', () => {
    const bypassed = evaluatePermission(
      writeTool,
      { path: 'src/config.env', content: 'x' },
      makeCtx({ mode: 'bypassPermissions' }),
    );
    expect(bypassed).toEqual({ kind: 'allow' });
    const fallback = evaluatePermission(
      writeTool,
      { path: 'src/config.env', content: 'x' },
      makeCtx(),
    );
    expect(fallback.kind).toBe('ask');
  });

  it('项目 .misty/settings.json 是用户配置，不拦', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: '.misty/settings.json', content: '{}' },
      makeCtx({ mode: 'bypassPermissions' }),
    );
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('读不拦：read .env 仍 allow', () => {
    expect(evaluatePermission(readTool, { path: '.env' }, makeCtx())).toEqual({ kind: 'allow' });
  });

  it('deny 规则仍优先于护栏，reason 是规则描述', () => {
    const decision = evaluatePermission(
      writeTool,
      { path: '.git/config', content: 'x' },
      makeCtx({ rules: [{ action: 'deny', tool: 'Write', pattern: '.git/**' }] }),
    );
    expect(decision.kind === 'deny' && decision.reason).toContain('deny 规则');
  });

  it('v1 边界：bash 命令内容不解析，bypass 下 bash 重定向写 .git 不拦', () => {
    const decision = evaluatePermission(
      bashTool,
      { command: 'echo x > .git/config' },
      makeCtx({ mode: 'bypassPermissions' }),
    );
    expect(decision).toEqual({ kind: 'allow' });
  });
});
