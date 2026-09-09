import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { editTool } from '#/core/tools/builtin/edit';
import { readTool } from '#/core/tools/builtin/read';
import {
  clearReadRegistry,
  hasRead,
} from '#/core/tools/builtin/read-registry';
import { writeTool } from '#/core/tools/builtin/write';
import type { ToolContext } from '#/core/tools/tool';

let cwd: string;
let ctx: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'misty-edit-fresh-'));
  ctx = { cwd, signal: new AbortController().signal };
});

describe('edit 新鲜度与先读约束', () => {
  it('未读取过的文件直接 edit 报错', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'hello', 'utf8');
    const result = await editTool.call(
      { path: 'a.txt', old_string: 'hello', new_string: 'world' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('has not been read in this session');
  });

  it('读取后被外部修改的文件拒绝 edit，重新 read 后恢复', async () => {
    await writeFile(path.join(cwd, 'b.txt'), 'v1', 'utf8');
    await readTool.call({ path: 'b.txt' }, ctx);
    await writeFile(path.join(cwd, 'b.txt'), 'v2-changed', 'utf8');

    const stale = await editTool.call(
      { path: 'b.txt', old_string: 'v2-changed', new_string: 'v3' },
      ctx,
    );
    expect(stale.isError).toBe(true);
    expect(stale.output).toContain('has been modified since you last read it');
    expect(await readFile(path.join(cwd, 'b.txt'), 'utf8')).toBe('v2-changed');

    await readTool.call({ path: 'b.txt' }, ctx);
    const ok = await editTool.call(
      { path: 'b.txt', old_string: 'v2-changed', new_string: 'v3' },
      ctx,
    );
    expect(ok.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'b.txt'), 'utf8')).toBe('v3');
  });

  it('edit 成功后登记新状态，连续 edit 无需重新 read', async () => {
    await writeFile(path.join(cwd, 'c.txt'), 'aaa\nbbb\n', 'utf8');
    await readTool.call({ path: 'c.txt' }, ctx);
    const first = await editTool.call(
      { path: 'c.txt', old_string: 'aaa', new_string: 'xxx' },
      ctx,
    );
    expect(first.isError).toBeUndefined();
    const second = await editTool.call(
      { path: 'c.txt', old_string: 'bbb', new_string: 'yyy' },
      ctx,
    );
    expect(second.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'c.txt'), 'utf8')).toBe('xxx\nyyy\n');
  });

  it('write 后的文件可直接 edit（write 登记落笔后状态）', async () => {
    await writeTool.call({ path: 'gen.txt', content: 'alpha\nbeta\n' }, ctx);
    const result = await editTool.call(
      { path: 'gen.txt', old_string: 'beta', new_string: 'gamma' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'gen.txt'), 'utf8')).toBe('alpha\ngamma\n');
  });
});

describe('write 新鲜度与未读覆盖提示', () => {
  it('覆盖已存在的未读文件成功，但输出带提示', async () => {
    await writeFile(path.join(cwd, 'w.txt'), 'old content', 'utf8');
    const result = await writeTool.call({ path: 'w.txt', content: 'new' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('not read in this session');
    expect(await readFile(path.join(cwd, 'w.txt'), 'utf8')).toBe('new');
  });

  it('读取后被外部修改的文件拒绝 write', async () => {
    await writeFile(path.join(cwd, 'w2.txt'), 'v1', 'utf8');
    await readTool.call({ path: 'w2.txt' }, ctx);
    await writeFile(path.join(cwd, 'w2.txt'), 'external-change', 'utf8');
    const result = await writeTool.call({ path: 'w2.txt', content: 'mine' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('has been modified since you last read it');
    expect(await readFile(path.join(cwd, 'w2.txt'), 'utf8')).toBe('external-change');
  });
});

describe('edit 空白/换行容错匹配', () => {
  it('CRLF 文件配 LF old_string 走容错替换，保留 CRLF 行尾', async () => {
    await writeFile(path.join(cwd, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n', 'utf8');
    await readTool.call({ path: 'crlf.txt' }, ctx);
    const result = await editTool.call(
      { path: 'crlf.txt', old_string: 'two\nthree', new_string: 'TWO\nTHREE' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('tolerant match');
    expect(await readFile(path.join(cwd, 'crlf.txt'), 'utf8')).toBe('one\r\nTWO\r\nTHREE\r\n');
  });

  it('缩进与行尾空白偏差走容错替换', async () => {
    await writeFile(path.join(cwd, 'indent.txt'), 'if (x) {\n    return 1;  \n}\n', 'utf8');
    await readTool.call({ path: 'indent.txt' }, ctx);
    const result = await editTool.call(
      { path: 'indent.txt', old_string: 'if (x) {\n  return 1;\n}', new_string: 'if (x) {\n  return 3;\n}' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'indent.txt'), 'utf8')).toBe(
      'if (x) {\n  return 3;\n}\n',
    );
  });

  it('容错匹配多命中且无 replace_all 时报错', async () => {
    await writeFile(path.join(cwd, 'dup.txt'), 'foo bar\nfoo bar\nfoo bar\n', 'utf8');
    await readTool.call({ path: 'dup.txt' }, ctx);
    const result = await editTool.call(
      { path: 'dup.txt', old_string: '  foo bar', new_string: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('matched 3 places');

    const all = await editTool.call(
      { path: 'dup.txt', old_string: '  foo bar', new_string: 'x', replace_all: true },
      ctx,
    );
    expect(all.isError).toBeUndefined();
    expect(await readFile(path.join(cwd, 'dup.txt'), 'utf8')).toBe('x\nx\nx\n');
  });

  it('精确与容错都未命中时报错', async () => {
    await writeFile(path.join(cwd, 'miss.txt'), 'aaa\nbbb\n', 'utf8');
    await readTool.call({ path: 'miss.txt' }, ctx);
    const result = await editTool.call(
      { path: 'miss.txt', old_string: 'zzz\nqqq', new_string: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('was not found in');
  });

  it('替换串中的 $ 模式按字面写入，不被展开', async () => {
    await writeFile(path.join(cwd, 'dollar.txt'), 'price: 10\n', 'utf8');
    await readTool.call({ path: 'dollar.txt' }, ctx);
    await editTool.call(
      { path: 'dollar.txt', old_string: '10', new_string: "$& $' $`" },
      ctx,
    );
    expect(await readFile(path.join(cwd, 'dollar.txt'), 'utf8')).toBe("price: $& $' $`\n");
  });
});

describe('read registry 生命周期', () => {
  it('clearReadRegistry 后 hasRead 归零（/clear 语义）', async () => {
    await writeFile(path.join(cwd, 'life.txt'), 'x', 'utf8');
    await readTool.call({ path: 'life.txt' }, ctx);
    expect(hasRead(path.join(cwd, 'life.txt'))).toBe(true);
    clearReadRegistry();
    expect(hasRead(path.join(cwd, 'life.txt'))).toBe(false);
  });
});
