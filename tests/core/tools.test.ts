import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { bashTool } from '#/core/tools/builtin/bash';
import { editTool } from '#/core/tools/builtin/edit';
import { globTool } from '#/core/tools/builtin/glob';
import { grepTool } from '#/core/tools/builtin/grep';
import { createBuiltinRegistry } from '#/core/tools/builtin/index';
import { readTool } from '#/core/tools/builtin/read';
import { writeTool } from '#/core/tools/builtin/write';
import type { ToolContext } from '#/core/tools/tool';

import { FakeProvider } from './fake-provider';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'misty-tools-'));
  ctx = { cwd, signal: new AbortController().signal };
});

describe('read', () => {
  it('带行号输出，支持 offset/limit', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');

    const full = await readTool.call({ path: 'a.txt' }, ctx);
    expect(full.isError).toBeUndefined();
    expect(full.output).toBe('1\tone\n2\ttwo\n3\tthree\n4\t');

    const slice = await readTool.call({ path: 'a.txt', offset: 2, limit: 1 }, ctx);
    expect(slice.output).toBe('2\ttwo\n[已截断：共 4 行，显示到第 2 行]');
  });

  it('文件不存在与目录都返回 isError', async () => {
    expect((await readTool.call({ path: 'nope.txt' }, ctx)).isError).toBe(true);
    expect((await readTool.call({ path: '.' }, ctx)).isError).toBe(true);
  });

  it('二进制文件返回 isError', async () => {
    await writeFile(path.join(cwd, 'bin'), Buffer.from([0x00, 0x01]));
    const result = await readTool.call({ path: 'bin' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('二进制');
  });

  it('isReadOnly 为 true', () => {
    expect(readTool.isReadOnly({ path: 'x' })).toBe(true);
  });
});

describe('write', () => {
  it('自动创建父目录并写入', async () => {
    const result = await writeTool.call({ path: 'deep/dir/f.txt', content: 'hello' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'deep/dir/f.txt'), 'utf8')).toBe('hello');
  });
});

describe('edit', () => {
  it('唯一替换成功', async () => {
    await writeFile(path.join(cwd, 'e.txt'), 'foo bar foo', 'utf8');
    const result = await editTool.call(
      { path: 'e.txt', old_string: 'bar', new_string: 'baz' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'e.txt'), 'utf8')).toBe('foo baz foo');
  });

  it('不唯一时报错，replace_all 替换全部', async () => {
    await writeFile(path.join(cwd, 'e.txt'), 'foo bar foo', 'utf8');
    const dup = await editTool.call({ path: 'e.txt', old_string: 'foo', new_string: 'x' }, ctx);
    expect(dup.isError).toBe(true);
    expect(dup.output).toContain('2 次');

    const all = await editTool.call(
      { path: 'e.txt', old_string: 'foo', new_string: 'x', replace_all: true },
      ctx,
    );
    expect(all.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'e.txt'), 'utf8')).toBe('x bar x');
  });

  it('old_string 不存在时报错', async () => {
    await writeFile(path.join(cwd, 'e.txt'), 'content', 'utf8');
    const result = await editTool.call({ path: 'e.txt', old_string: 'zz', new_string: 'y' }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe('bash', () => {
  it('执行 echo 并返回输出', async () => {
    const result = await bashTool.call({ command: 'echo hello-misty' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('hello-misty');
  });

  it('非零退出码返回 isError', async () => {
    const result = await bashTool.call({ command: 'exit 3' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('exit code 3');
  });

  it('超时被终止', async () => {
    const result = await bashTool.call(
      { command: 'node -e "setTimeout(()=>{}, 5000)"', timeout: 200 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('超时');
  });
});

describe('glob', () => {
  it('按模式匹配并跳过 node_modules', async () => {
    await mkdir(path.join(cwd, 'src/deep'), { recursive: true });
    await mkdir(path.join(cwd, 'node_modules/pkg'), { recursive: true });
    await writeFile(path.join(cwd, 'src/a.ts'), '', 'utf8');
    await writeFile(path.join(cwd, 'src/deep/b.ts'), '', 'utf8');
    await writeFile(path.join(cwd, 'README.md'), '', 'utf8');
    await writeFile(path.join(cwd, 'node_modules/pkg/c.ts'), '', 'utf8');

    const result = await globTool.call({ pattern: '**/*.ts' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output.split('\n')).toEqual(['src/a.ts', 'src/deep/b.ts']);

    const shallow = await globTool.call({ pattern: 'src/*.ts' }, ctx);
    expect(shallow.output).toBe('src/a.ts');
  });

  it('目录不存在返回 isError', async () => {
    expect((await globTool.call({ pattern: '*', path: 'nope' }, ctx)).isError).toBe(true);
  });
});

describe('grep', () => {
  it('输出 path:line:content，支持 include 过滤', async () => {
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(path.join(cwd, 'src/a.ts'), 'const foo = 1;\nconst bar = 2;\n', 'utf8');
    await writeFile(path.join(cwd, 'b.md'), 'foo in md\n', 'utf8');

    const all = await grepTool.call({ pattern: 'foo' }, ctx);
    expect(all.isError).toBeUndefined();
    expect(all.output.split('\n').toSorted()).toEqual(['b.md:1:foo in md', 'src/a.ts:1:const foo = 1;']);

    const onlyTs = await grepTool.call({ pattern: 'foo', include: '*.ts' }, ctx);
    expect(onlyTs.output).toBe('src/a.ts:1:const foo = 1;');
  });

  it('非法正则返回 isError', async () => {
    const result = await grepTool.call({ pattern: '([' }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe('registry', () => {
  it('注册内置工具并输出 ToolDefinition（无宿主能力时不含 agent）', () => {
    const registry = createBuiltinRegistry();
    expect(registry.list().map((t) => t.name).toSorted()).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'read',
      'todo',
      'web_fetch',
      'web_search',
      'write',
    ]);
    for (const definition of registry.definitions()) {
      expect(definition.parameters).toMatchObject({ type: 'object' });
    }
    expect(() => registry.register(readTool)).toThrow('重复注册');
  });

  it('提供 provider + getModel 宿主能力时额外注册 agent 工具', () => {
    const registry = createBuiltinRegistry({
      provider: new FakeProvider([]),
      getModel: () => 'fake-model',
    });
    expect(registry.list().map((t) => t.name).toSorted()).toContain('agent');
  });

  it('describeCall 描述调用，非法 input 回退为工具名', () => {
    expect(readTool.describeCall({ path: 'src/foo.ts' })).toBe('Read src/foo.ts');
    expect(readTool.describeCall({ nope: 1 })).toBe('read');
  });
});
