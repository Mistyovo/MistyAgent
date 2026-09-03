import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENTS_MD_SEPARATOR,
  collectAgentsDocs,
  findProjectRoot,
  PROJECT_DOC_MAX_BYTES,
} from '#/core/context/agents-md';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'misty-agents-md-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findProjectRoot', () => {
  it('向上找含 .git 的目录', () => {
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    expect(findProjectRoot(sub)).toBe(root);
  });

  it('找不到 .git 时以 cwd 自身为 root', () => {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    expect(findProjectRoot(sub)).toBe(sub);
  });
});

describe('collectAgentsDocs', () => {
  it('按 root→cwd 顺序拼接各层 AGENTS.md', () => {
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(root, 'AGENTS.md'), 'root-doc');
    writeFileSync(join(sub, 'AGENTS.md'), 'sub-doc');

    expect(collectAgentsDocs(sub)).toBe(`root-doc${AGENTS_MD_SEPARATOR}sub-doc`);
  });

  it('中间层缺文件时跳过', () => {
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'root-doc');
    writeFileSync(join(sub, 'AGENTS.md'), 'leaf-doc');

    expect(collectAgentsDocs(sub)).toBe(`root-doc${AGENTS_MD_SEPARATOR}leaf-doc`);
  });

  it('没有 .git 时只收集 cwd 自身的 AGENTS.md', () => {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(root, 'AGENTS.md'), 'root-doc');
    writeFileSync(join(sub, 'AGENTS.md'), 'sub-doc');

    expect(collectAgentsDocs(sub)).toBe('sub-doc');
  });

  it('任何层都没有 AGENTS.md 时返回空串', () => {
    expect(collectAgentsDocs(root)).toBe('');
  });

  it('总字节超出 32KB 时截断', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(PROJECT_DOC_MAX_BYTES + 1024));

    const docs = collectAgentsDocs(root);

    expect(Buffer.byteLength(docs, 'utf8')).toBe(PROJECT_DOC_MAX_BYTES);
  });

  it('root 文档占满预算后不再读下层', () => {
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'sub');
    mkdirSync(sub);
    writeFileSync(join(root, 'AGENTS.md'), 'x'.repeat(PROJECT_DOC_MAX_BYTES));
    writeFileSync(join(sub, 'AGENTS.md'), 'sub-doc');

    const docs = collectAgentsDocs(sub);

    expect(docs).not.toContain('sub-doc');
  });
});
