import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { settingsSchema } from '#/config/schema';
import { loadSettings } from '#/config/settings';
import type { AgentEvent, HookNoticeEvent } from '#/core/events';
import { HookRunner } from '#/core/hooks';
import { runTurn, type RunTurnDeps } from '#/core/loop/run-turn';
import { createPermissionRuntime } from '#/core/permission/pipeline';
import { Session } from '#/core/session/session';
import { writeTool } from '#/core/tools/builtin/write';
import { defineTool, type Tool } from '#/core/tools/tool';

import { FakeProvider, textStep, toolCallStep } from './fake-provider';

/** 跨平台 hook 命令：node -e 经 cmd.exe / sh 都能跑；脚本内只用单引号 */
const echoStdout = (text: string): string => `node -e "console.log('${text}')"`;
const stdinScript = (body: string): string =>
  `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{${body}})"`;
const writeStdinToFile = (fileName: string): string =>
  stdinScript(`require('fs').writeFileSync('${fileName}',d)`);
const writeHelloCall = () =>
  toolCallStep([{ name: 'write', arguments: '{"path":"out.txt","content":"hello"}' }]);

describe('HookRunner', () => {
  it('matcher 过滤：正则命中才执行，缺省匹配全部', async () => {
    const runner = new HookRunner({
      preToolUse: [
        { matcher: 'write|edit', command: echoStdout('matched-write') },
        { command: echoStdout('matched-all') },
      ],
    });

    const forRead = await runner.run({ event: 'preToolUse', toolName: 'read', cwd: process.cwd() });
    expect(forRead.denied).toBe(false);
    expect(forRead.stdout).toBe('matched-all');

    const forWrite = await runner.run({ event: 'preToolUse', toolName: 'write', cwd: process.cwd() });
    expect(forWrite.stdout).toBe('matched-write\nmatched-all');

    const forEdit = await runner.run({ event: 'preToolUse', toolName: 'my_edit_tool', cwd: process.cwd() });
    expect(forEdit.stdout).toContain('matched-write');
  });

  it('stop 事件忽略 matcher', async () => {
    const runner = new HookRunner({
      stop: [{ matcher: 'write', command: echoStdout('stop-ran') }],
    });
    const result = await runner.run({ event: 'stop', cwd: process.cwd() });
    expect(result.stdout).toBe('stop-ran');
  });

  it('stdin 传递 JSON：event/toolName/input/cwd 字段完整', async () => {
    const runner = new HookRunner({
      preToolUse: [
        {
          command: stdinScript(
            `const j=JSON.parse(d);console.log([j.event,j.toolName,j.input.path,j.cwd.length>0].join('|'))`,
          ),
        },
      ],
    });
    const result = await runner.run({
      event: 'preToolUse',
      toolName: 'write',
      toolInput: { path: 'a.txt' },
      cwd: process.cwd(),
    });
    expect(result.stdout).toBe('preToolUse|write|a.txt|true');
  });

  it('postToolUse 的 stdin JSON 带 output 与 isError', async () => {
    const runner = new HookRunner({
      postToolUse: [
        {
          command: stdinScript(
            `const j=JSON.parse(d);console.log([j.event,j.output,j.isError].join('|'))`,
          ),
        },
      ],
    });
    const result = await runner.run({
      event: 'postToolUse',
      toolName: 'bash',
      toolInput: { command: 'ls' },
      toolOutput: 'file.txt',
      isError: false,
      cwd: process.cwd(),
    });
    expect(result.stdout).toBe('postToolUse|file.txt|false');
  });

  it('环境变量携带 MISTY_HOOK_EVENT / MISTY_HOOK_TOOL_NAME', async () => {
    const runner = new HookRunner({
      preToolUse: [
        {
          command: `node -e "console.log(process.env.MISTY_HOOK_EVENT + '|' + process.env.MISTY_HOOK_TOOL_NAME)"`,
        },
      ],
    });
    const result = await runner.run({ event: 'preToolUse', toolName: 'write', cwd: process.cwd() });
    expect(result.stdout).toBe('preToolUse|write');
  });

  it('超时被杀：记 warning 不阻断', async () => {
    const runner = new HookRunner(
      { stop: [{ command: 'node -e "setTimeout(()=>{},60000)"' }] },
      { timeoutMs: 300 },
    );
    const started = Date.now();
    const result = await runner.run({ event: 'stop', cwd: process.cwd() });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.denied).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('超时');
  });

  it('进程启动失败（cwd 不存在）：记 warning 不阻断', async () => {
    const runner = new HookRunner({ preToolUse: [{ command: echoStdout('never') }] });
    const result = await runner.run({
      event: 'preToolUse',
      toolName: 'write',
      cwd: path.join(process.cwd(), 'nonexistent-dir-xyz-123'),
    });
    expect(result.denied).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('启动失败');
  });

  it('preToolUse deny：exit code 非 0，stderr 作为 reason', async () => {
    const runner = new HookRunner({
      preToolUse: [{ command: `node -e "console.error('no writes today');process.exit(2)"` }],
    });
    const result = await runner.run({ event: 'preToolUse', toolName: 'write', cwd: process.cwd() });
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('no writes today');
  });

  it('preToolUse deny：stdout JSON {"decision":"deny","reason":...}', async () => {
    const runner = new HookRunner({
      preToolUse: [
        { command: `node -e "console.log(JSON.stringify({decision:'deny',reason:'policy violation'}))"` },
      ],
    });
    const result = await runner.run({ event: 'preToolUse', toolName: 'write', cwd: process.cwd() });
    expect(result.denied).toBe(true);
    expect(result.reason).toBe('policy violation');
  });

  it('preToolUse：非 deny JSON 或普通 stdout 不阻断，stdout 进提示', async () => {
    const runner = new HookRunner({
      preToolUse: [
        { command: `node -e "console.log(JSON.stringify({decision:'allow'}))"` },
        { command: echoStdout('just a note') },
      ],
    });
    const result = await runner.run({ event: 'preToolUse', toolName: 'write', cwd: process.cwd() });
    expect(result.denied).toBe(false);
    expect(result.stdout).toContain('just a note');
  });

  it('preToolUse 首个 deny 短路：后续 hook 不再执行', async () => {
    const runner = new HookRunner({
      preToolUse: [
        { command: `node -e "process.exit(1)"` },
        { command: echoStdout('second-ran') },
      ],
    });
    const result = await runner.run({ event: 'preToolUse', toolName: 'write', cwd: process.cwd() });
    expect(result.denied).toBe(true);
    expect(result.stdout).not.toContain('second-ran');
  });

  it('postToolUse 非零退出只记 warning，不阻断', async () => {
    const runner = new HookRunner({
      postToolUse: [{ command: `node -e "console.error('lint failed');process.exit(1)"` }],
    });
    const result = await runner.run({
      event: 'postToolUse',
      toolName: 'write',
      toolOutput: 'ok',
      cwd: process.cwd(),
    });
    expect(result.denied).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('退出码');
    expect(result.warnings[0]).toContain('lint failed');
  });
});

describe('hooks 配置', () => {
  it('zod 校验：matcher 非法正则报错', () => {
    const parsed = settingsSchema.safeParse({
      provider: { type: 'openai', defaultModel: 'm' },
      hooks: { preToolUse: [{ matcher: '(', command: 'x' }] },
    });
    expect(parsed.success).toBe(false);
  });

  it('zod 校验：合法 hooks 配置通过，command 空串拒绝', () => {
    const ok = settingsSchema.safeParse({
      provider: { type: 'openai', defaultModel: 'm' },
      hooks: {
        preToolUse: [{ matcher: 'write|edit', command: 'node check.js' }],
        postToolUse: [{ command: 'echo done' }],
        stop: [{ command: 'echo bye' }],
      },
    });
    expect(ok.success).toBe(true);

    const empty = settingsSchema.safeParse({
      provider: { type: 'openai', defaultModel: 'm' },
      hooks: { stop: [{ command: '' }] },
    });
    expect(empty.success).toBe(false);
  });

  describe('分层合并', () => {
    let root: string;
    let userSettingsPath: string;
    let projectDir: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'misty-hooks-config-'));
      userSettingsPath = path.join(root, 'home', '.misty', 'settings.json');
      projectDir = path.join(root, 'project');
      await mkdir(path.dirname(userSettingsPath), { recursive: true });
      await mkdir(path.join(projectDir, '.misty'), { recursive: true });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('user 与 project 层的 hooks 数组拼接累加', async () => {
      await writeFile(
        userSettingsPath,
        JSON.stringify({ hooks: { preToolUse: [{ command: 'user-hook' }] } }),
      );
      await writeFile(
        path.join(projectDir, '.misty', 'settings.json'),
        JSON.stringify({
          hooks: {
            preToolUse: [{ matcher: 'write', command: 'project-hook' }],
            stop: [{ command: 'stop-hook' }],
          },
        }),
      );
      const { settings } = loadSettings(projectDir, {}, { userSettingsPath, env: {} });
      expect(settings.hooks?.preToolUse).toEqual([
        { command: 'user-hook' },
        { matcher: 'write', command: 'project-hook' },
      ]);
      expect(settings.hooks?.stop).toEqual([{ command: 'stop-hook' }]);
    });
  });
});

describe('hooks 集成（runTurn + 真实 hook 进程）', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'misty-hooks-it-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeDeps(
    provider: FakeProvider,
    tools: Tool[],
    events: AgentEvent[],
    hooks: ConstructorParameters<typeof HookRunner>[0],
  ): RunTurnDeps {
    return {
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      cwd: dir,
      signal: new AbortController().signal,
      dispatchEvent: (event) => events.push(event),
      permission: createPermissionRuntime({ mode: 'bypassPermissions', cwd: dir }),
      hooks: new HookRunner(hooks),
    };
  }

  it('preToolUse deny 阻断 write：文件未落盘，reason 回喂模型', async () => {
    const provider = new FakeProvider([writeHelloCall(), textStep('了解了')]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [writeTool], events, {
      preToolUse: [
        { matcher: 'write', command: `node -e "console.error('blocked by policy');process.exit(2)"` },
      ],
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    expect(existsSync(path.join(dir, 'out.txt'))).toBe(false);
    const toolMessage = deps.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ isError: true });
    expect((toolMessage as { content: string }).content).toContain('blocked by policy');
    // 模型在下一步请求中收到了 deny 原因
    expect(provider.requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', isError: true });
    // deny 的工具未真正执行：没有 tool-call-started
    expect(events.some((e) => e.type === 'tool-call-started' && e.name === 'write')).toBe(false);
  });

  it('preToolUse JSON deny 同样阻断执行', async () => {
    const provider = new FakeProvider([writeHelloCall(), textStep('ok')]);
    const deps = makeDeps(provider, [writeTool], [], {
      preToolUse: [
        {
          command: `node -e "console.log(JSON.stringify({decision:'deny',reason:'no json writes'}))"`,
        },
      ],
    });

    await runTurn(deps);

    expect(existsSync(path.join(dir, 'out.txt'))).toBe(false);
    const toolMessage = deps.messages.find((m) => m.role === 'tool') as { content: string };
    expect(toolMessage.content).toContain('no json writes');
  });

  it('postToolUse 收到完整 JSON：event/toolName/input/output/isError', async () => {
    const provider = new FakeProvider([writeHelloCall(), textStep('done')]);
    const deps = makeDeps(provider, [writeTool], [], {
      postToolUse: [{ matcher: '^write$', command: writeStdinToFile('post-hook.json') }],
    });

    await runTurn(deps);

    const payload = JSON.parse(await readFile(path.join(dir, 'post-hook.json'), 'utf8')) as {
      event: string;
      toolName: string;
      input: { path: string; content: string };
      output: string;
      isError: boolean;
      cwd: string;
    };
    expect(payload.event).toBe('postToolUse');
    expect(payload.toolName).toBe('write');
    expect(payload.input).toEqual({ path: 'out.txt', content: 'hello' });
    expect(payload.output).toContain('已写入');
    expect(payload.isError).toBe(false);
    expect(payload.cwd).toBe(dir);
    // 工具真实执行了
    expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('postToolUse stdout 非空时 dispatch hook-notice 上屏', async () => {
    const provider = new FakeProvider([writeHelloCall(), textStep('done')]);
    const events: AgentEvent[] = [];
    const deps = makeDeps(provider, [writeTool], events, {
      postToolUse: [{ command: echoStdout('lint clean') }],
    });

    await runTurn(deps);

    const notice = events.find((e): e is HookNoticeEvent => e.type === 'hook-notice');
    expect(notice).toMatchObject({ hookEvent: 'postToolUse', text: 'lint clean', isWarning: false });
  });

  it('stop hook 在 turn 正常结束时触发', async () => {
    const provider = new FakeProvider([textStep('finished')]);
    const deps = makeDeps(provider, [], [], {
      stop: [{ command: writeStdinToFile('stop-hook.json') }],
    });

    const result = await runTurn(deps);

    expect(result.stopReason).toBe('completed');
    const payload = JSON.parse(await readFile(path.join(dir, 'stop-hook.json'), 'utf8')) as {
      event: string;
      cwd: string;
    };
    expect(payload.event).toBe('stop');
    expect(payload.cwd).toBe(dir);
  });

  it('中断的 turn 不触发 stop hook', async () => {
    const log: string[] = [];
    const slowTool = defineTool({
      name: 'slow',
      description: '慢写操作',
      inputSchema: z.object({}),
      accesses: () => [{ kind: 'write' }],
      call: (_input, ctx) => {
        log.push('slow:start');
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const provider = new FakeProvider([toolCallStep([{ name: 'slow', arguments: '{}' }])]);
    const controller = new AbortController();
    const deps = makeDeps(provider, [slowTool], [], {
      stop: [{ command: writeStdinToFile('stop-hook.json') }],
    });
    deps.signal = controller.signal;

    const resultPromise = runTurn(deps);
    await vi.waitFor(() => {
      expect(log).toContain('slow:start');
    });
    controller.abort();
    const result = await resultPromise;

    expect(result.stopReason).toBe('interrupted');
    expect(existsSync(path.join(dir, 'stop-hook.json'))).toBe(false);
  });

  it('Session 层接线：hooks 配置经 Session 传入并在 turn 中生效', async () => {
    const provider = new FakeProvider([writeHelloCall(), textStep('ok')]);
    const session = new Session({
      provider,
      model: 'fake-model',
      systemPrompt: 'system',
      tools: [writeTool],
      cwd: dir,
      permission: { mode: 'bypassPermissions' },
      hooks: {
        preToolUse: [{ command: `node -e "console.error('session-level deny');process.exit(1)"` }],
        stop: [{ command: writeStdinToFile('stop-hook.json') }],
      },
    });

    const result = await session.submit({ type: 'user-turn', text: '写个文件' });

    expect(result.stopReason).toBe('completed');
    expect(existsSync(path.join(dir, 'out.txt'))).toBe(false);
    const toolMessage = session.getMessages().find((m) => m.role === 'tool');
    expect((toolMessage as { content: string }).content).toContain('session-level deny');
    // turn 正常收尾，stop hook 落盘
    expect(existsSync(path.join(dir, 'stop-hook.json'))).toBe(true);
  });
});
