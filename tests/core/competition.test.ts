import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompetitionApiError, CompetitionClient } from '#/core/competition';
import { createCompetitionTools } from '#/core/tools/builtin/competition';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import type { ToolContext } from '#/core/tools/tool';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let lastUrl: string | undefined;
let ctx: ToolContext;

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(404);
    res.end();
  };
  server = createServer((req, res) => {
    lastUrl = req.url;
    handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  ctx = { cwd: process.cwd(), signal: new AbortController().signal };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function respondJson(body: unknown): void {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

const client = (): CompetitionClient => new CompetitionClient({ token: 'team-token', baseUrl });

// 与接口文档"实际返回示例"同构的最小样本
const SAMPLE_QUESTIONS = [
  {
    question_id: 'q-web-1',
    title: '测试2_docker',
    score: 500,
    real_score: 500,
    file_url: '',
    is_solved: false,
    solved_number: 0,
    category: 'web',
    attributes: ['标签'],
    description: 'test',
    interactive: 'true',
    capabilities: ['docker'],
    connection: { docker_url: 'example.com:80' },
    extensions: { web: '<Web扩展信息>' },
  },
  {
    question_id: 'q-misc-2',
    title: '测试_附件',
    score: 100,
    real_score: 100,
    file_url: 'https://files.example.com/attach.zip',
    is_solved: true,
    solved_number: 3,
    category: 'misc',
    attributes: ['杂项'],
    description: '测试_多附件题目',
    interactive: 'false',
    capabilities: [],
    connection: [],
    extensions: {},
  },
];

describe('CompetitionClient', () => {
  it('listQuestions 拉取并归一化赛题（connection 对象与 []、interactive 字符串）', async () => {
    respondJson({ code: 0, message: '查询成功', data: SAMPLE_QUESTIONS });
    const questions = await client().listQuestions();
    expect(lastUrl).toBe('/04cb510e425bd8f64fa97ba66f3935e1?token=team-token');
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      questionId: 'q-web-1',
      title: '测试2_docker',
      interactive: true,
      connection: { docker_url: 'example.com:80' },
      isSolved: false,
    });
    expect(questions[1]).toMatchObject({
      questionId: 'q-misc-2',
      interactive: false,
      connection: undefined,
      isSolved: true,
      fileUrl: 'https://files.example.com/attach.zip',
    });
  });

  it('listQuestions 对空 data 与缺失 data 容错', async () => {
    respondJson({ code: 0, message: '查询成功', data: [] });
    expect(await client().listQuestions()).toEqual([]);
    respondJson({ code: 0, message: '查询成功' });
    expect(await client().listQuestions()).toEqual([]);
  });

  it('listQuestions 对平台拒绝（code !== 0）抛 CompetitionApiError', async () => {
    respondJson({ code: 401, message: 'token 无效' });
    const error = await client().listQuestions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompetitionApiError);
    expect((error as CompetitionApiError).message).toContain('token 无效');
    expect((error as CompetitionApiError).code).toBe(401);
  });

  it('listQuestions 对 HTTP 错误与非 JSON 响应抛错', async () => {
    handler = (_req, res) => {
      res.writeHead(502);
      res.end('bad gateway');
    };
    await expect(client().listQuestions()).rejects.toThrow(/HTTP 502/);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not json</html>');
    };
    await expect(client().listQuestions()).rejects.toThrow(/non-JSON/);
  });

  it('resetEnvironment 携带 question_id 并返回平台 message', async () => {
    respondJson({ code: 0, message: '操作成功' });
    const message = await client().resetEnvironment('q-web-1');
    expect(lastUrl).toBe('/deed3dba39e57b7cf95ea63ddd84e0c8?token=team-token&question_id=q-web-1');
    expect(message).toBe('操作成功');
  });

  it('submitFlag status=1 判定正确并编码 answer', async () => {
    respondJson({ code: 0, message: '答案正确', status: 1 });
    const outcome = await client().submitFlag('q-web-1', 'flag{hello world}');
    expect(lastUrl).toBe(
      '/ff874ef3172cbf4fd6ec2c5653a568e2?token=team-token&question_id=q-web-1&answer=flag%7Bhello%20world%7D',
    );
    expect(outcome).toEqual({ correct: true, message: '答案正确' });
  });

  it('submitFlag code=0 无 status 判定错误但不抛错', async () => {
    respondJson({ code: 0, message: '答案错误' });
    const outcome = await client().submitFlag('q-web-1', 'flag{wrong}');
    expect(outcome).toEqual({ correct: false, message: '答案错误' });
  });

  it('submitFlag 对平台拒绝抛 CompetitionApiError', async () => {
    respondJson({ code: 500, message: '题目不存在' });
    await expect(client().submitFlag('missing', 'flag{x}')).rejects.toThrow(/题目不存在/);
  });
});

describe('competition tools', () => {
  it('competition_list 输出标题/id/附件/接入信息并标记已解出', async () => {
    respondJson({ code: 0, message: '查询成功', data: SAMPLE_QUESTIONS });
    const list = createCompetitionTools(client())[0]!;
    const result = await list.call({}, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('测试2_docker');
    expect(result.output).toContain('id=q-web-1');
    expect(result.output).toContain('connection: example.com:80');
    expect(result.output).toContain('https://files.example.com/attach.zip');
    expect(result.output).toContain('SOLVED');
    expect(list.isReadOnly({})).toBe(true);
    expect(list.describeCall({})).toBe('List competition questions');
  });

  it('competition_list 对纯 ip+数字端口的接入信息组合出 nc 命令（真实平台形态）', async () => {
    respondJson({
      code: 0,
      message: '查询成功',
      data: [
        {
          question_id: 'q-pwn-3',
          title: 'pwn01',
          score: 500,
          real_score: 500,
          file_url: '',
          is_solved: false,
          solved_number: 86,
          category: 'pwn',
          attributes: ['docker'],
          description: 'test',
          interactive: 'true',
          capabilities: ['docker'],
          connection: { docker_ip: '39.106.48.123', docker_port: 45277 },
          extensions: {},
        },
      ],
    });
    const list = createCompetitionTools(client())[0]!;
    const result = await list.call({}, ctx);
    expect(result.output).toContain('connection: nc 39.106.48.123 45277');
  });

  it('competition_reset 成功与平台拒绝分别回喂', async () => {
    const [, reset] = createCompetitionTools(client());
    respondJson({ code: 0, message: '操作成功' });
    const ok = await reset!.call({ questionId: 'q-web-1' }, ctx);
    expect(ok.output).toContain('操作成功');
    respondJson({ code: 1, message: '仅容器题支持重置' });
    const rejected = await reset!.call({ questionId: 'q-misc-2' }, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.output).toContain('仅容器题支持重置');
  });

  it('competition_submit 正确与错误 flag 分别回喂', async () => {
    const [list, , submit] = createCompetitionTools(client());
    respondJson({ code: 0, message: '答案正确', status: 1 });
    const ok = await submit!.call({ questionId: 'q-web-1', flag: 'flag{yes}' }, ctx);
    expect(ok.isError).toBeUndefined();
    expect(ok.output).toContain('Correct');
    respondJson({ code: 0, message: '答案错误' });
    const wrong = await submit!.call({ questionId: 'q-web-1', flag: 'flag{no}' }, ctx);
    expect(wrong.isError).toBe(true);
    expect(wrong.output).toContain('Incorrect');
    expect(submit!.describeCall({ questionId: 'q-web-1', flag: 'flag{no}' })).toContain('q-web-1');
    expect(list!.name).toBe('competition_list');
  });

  it('网络失败转为 isError 工具结果而非抛出', async () => {
    const offline = new CompetitionClient({ token: 't', baseUrl: 'http://127.0.0.1:1' });
    const [list] = createCompetitionTools(offline);
    const result = await list!.call({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('failed');
  });
});

describe('builtin registry wiring', () => {
  it('提供 CompetitionClient 时注册三件套，缺省时不注册', () => {
    const withCompetition = createBuiltinRegistry({ competition: client() });
    const names = withCompetition.list().map((tool) => tool.name);
    expect(names).toContain('competition_list');
    expect(names).toContain('competition_reset');
    expect(names).toContain('competition_submit');

    const withoutCompetition = createBuiltinRegistry();
    const plainNames = withoutCompetition.list().map((tool) => tool.name);
    expect(plainNames).not.toContain('competition_list');
    expect(plainNames).not.toContain('competition_reset');
    expect(plainNames).not.toContain('competition_submit');
  });

  it('competition_list 的 JSON schema 供模型调用', () => {
    const registry = createBuiltinRegistry({ competition: client() });
    const definition = registry.get('competition_submit')!.toJSONSchema();
    expect(definition.name).toBe('competition_submit');
    expect(definition.parameters).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        questionId: expect.any(Object),
        flag: expect.any(Object),
      }),
      required: ['questionId', 'flag'],
    });
  });
});
