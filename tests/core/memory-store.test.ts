import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMemoryDir, getMemoryIndexPath, isMemoryPath } from '#/core/memory/paths';
import { buildMemorySystemPromptSection } from '#/core/memory/section';
import {
  MAX_INDEX_BYTES,
  MAX_INDEX_LINES,
  formatMemoryManifest,
  readMemoryIndex,
  scanMemoryFiles,
  truncateIndexContent,
} from '#/core/memory/store';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'misty-mem-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const memoryFile = (description: string, extra = ''): string =>
  `---\nname: 测试记忆\ndescription: ${description}\ntype: user\n---\n\n${extra}正文。\n`;

describe('paths', () => {
  it('记忆目录与索引路径', () => {
    expect(getMemoryDir()).toBe(path.join(homedir(), '.misty', 'memory'));
    expect(getMemoryIndexPath()).toBe(path.join(getMemoryDir(), 'MEMORY.md'));
  });

  it('isMemoryPath 判断目录内外', () => {
    expect(isMemoryPath(path.join(dir, 'a.md'), dir)).toBe(true);
    expect(isMemoryPath(path.join(dir, 'sub', 'a.md'), dir)).toBe(true);
    expect(isMemoryPath(path.join(dir, '..', 'b.md'), dir)).toBe(false);
    expect(isMemoryPath(dir, dir)).toBe(true);
  });

  it('isMemoryPath 在 Windows 大小写不敏感', () => {
    const inner = path.join(dir, 'A.md');
    const swapped = inner.replace(/^([a-zA-Z])/, (c) =>
      c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(),
    );
    expect(isMemoryPath(swapped, dir)).toBe(process.platform === 'win32');
  });
});

describe('truncateIndexContent', () => {
  it('未超限原样返回（trim）', () => {
    const raw = '  - [a](a.md) — 一条\n';
    expect(truncateIndexContent(raw)).toEqual({
      content: '- [a](a.md) — 一条',
      wasTruncated: false,
    });
  });

  it('超行数上限：截到 200 行并附行数警告', () => {
    const raw = Array.from({ length: MAX_INDEX_LINES + 1 }, (_, i) => `- [m${i}](m${i}.md)`).join(
      '\n',
    );
    const result = truncateIndexContent(raw);
    expect(result.wasTruncated).toBe(true);
    expect(result.content).toContain('- [m0](m0.md)');
    expect(result.content).not.toContain(`- [m${MAX_INDEX_LINES}](m${MAX_INDEX_LINES}.md)`);
    expect(result.content).toContain('警告');
    expect(result.content).toContain(`${MAX_INDEX_LINES}`);
    expect(result.content).toContain('行');
    expect(result.content).toContain('细节挪进主题文件');
  });

  it('超体积上限：按换行边界截断并附体积警告', () => {
    const longLine = `- [x](x.md) — ${'长'.repeat(400)}`;
    const raw = Array.from({ length: 80 }, () => longLine).join('\n');
    expect(raw.length).toBeGreaterThan(MAX_INDEX_BYTES);
    const result = truncateIndexContent(raw);
    expect(result.wasTruncated).toBe(true);
    expect(result.content).toContain('警告');
    expect(result.content).toContain('体积');
    expect(result.content).toContain(`${MAX_INDEX_BYTES}`);
  });
});

describe('readMemoryIndex', () => {
  it('索引不存在返回 null', () => {
    expect(readMemoryIndex(dir)).toBeNull();
  });

  it('索引存在返回原文', async () => {
    await writeFile(path.join(dir, 'MEMORY.md'), '- [a](a.md) — 一条\n', 'utf8');
    expect(readMemoryIndex(dir)).toBe('- [a](a.md) — 一条\n');
  });
});

describe('scanMemoryFiles', () => {
  it('解析 frontmatter、按 mtimeMs 倒序、跳过坏文件与索引', async () => {
    const older = path.join(dir, 'b.md');
    const newer = path.join(dir, 'a.md');
    await writeFile(older, memoryFile('较早的记忆'), 'utf8');
    await writeFile(newer, memoryFile('较新的记忆'), 'utf8');
    await writeFile(path.join(dir, 'no-desc.md'), '---\nname: 缺简介\n---\n\n正文\n', 'utf8');
    await writeFile(path.join(dir, 'bad.md'), '没有 frontmatter 的文件\n', 'utf8');
    await writeFile(path.join(dir, 'MEMORY.md'), '- 索引\n', 'utf8');
    await writeFile(path.join(dir, 'note.txt'), memoryFile('不是 md'), 'utf8');
    await utimes(older, new Date('2024-01-01'), new Date('2024-01-01'));
    await utimes(newer, new Date('2024-06-01'), new Date('2024-06-01'));

    const headers = scanMemoryFiles(dir);

    expect(headers.map((h) => h.filename)).toEqual(['a.md', 'b.md']);
    expect(headers[0]!.name).toBe('测试记忆');
    expect(headers[0]!.description).toBe('较新的记忆');
    expect(headers[0]!.type).toBe('user');
    expect(headers[0]!.filePath).toBe(newer);
    expect(headers[0]!.mtimeMs).toBeGreaterThan(headers[1]!.mtimeMs);
  });

  it('非法 type 降级为 undefined，缺 name 回退文件名', async () => {
    await writeFile(
      path.join(dir, 'x.md'),
      '---\ndescription: 类型未知\ntype: unknown-type\n---\n\n正文\n',
      'utf8',
    );
    const headers = scanMemoryFiles(dir);
    expect(headers).toHaveLength(1);
    expect(headers[0]!.type).toBeUndefined();
    expect(headers[0]!.name).toBe('x.md');
  });

  it('目录不存在返回空数组', () => {
    expect(scanMemoryFiles(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('formatMemoryManifest', () => {
  it('每行 filename — description', async () => {
    await writeFile(path.join(dir, 'a.md'), memoryFile('简介甲'), 'utf8');
    const headers = scanMemoryFiles(dir);
    expect(formatMemoryManifest(headers)).toBe('a.md — 简介甲');
    expect(formatMemoryManifest([])).toBe('');
  });
});

describe('buildMemorySystemPromptSection', () => {
  it('无索引时仍返回完整指引（含目录路径），并确保目录已创建', async () => {
    const fresh = path.join(dir, 'fresh-memory');
    const section = buildMemorySystemPromptSection(fresh);
    expect(section).toContain(fresh);
    expect(section).toContain('记忆类型');
    expect(section).toContain('不要存什么');
    expect(section).toContain('如何保存记忆');
    expect(section).toContain('何时读取记忆');
    expect(section).toContain('依据记忆给出建议之前');
    expect(section).not.toContain('当前记忆索引');
    expect(scanMemoryFiles(fresh)).toEqual([]);
  });

  it('有索引时末尾附当前记忆索引及内容', async () => {
    await writeFile(path.join(dir, 'MEMORY.md'), '- [a](a.md) — 一条记忆\n', 'utf8');
    const section = buildMemorySystemPromptSection(dir);
    expect(section).toContain('当前记忆索引');
    expect(section).toContain('- [a](a.md) — 一条记忆');
  });
});
