import { errorMessage } from './errors';
import { DEFAULT_WEB_TIMEOUT_MS, isTimeoutError, webGet } from './tools/builtin/web-utils';

/** 湾区杯 Agent 大赛平台（春秋GAME apiterminator）默认地址，可用 MISTY_CTF_BASE_URL 覆盖 */
export const COMPETITION_API_BASE_URL = 'https://apiterminator.ichunqiu.com';

const QUERY_PATH = '/04cb510e425bd8f64fa97ba66f3935e1';
const RESET_PATH = '/deed3dba39e57b7cf95ea63ddd84e0c8';
const SUBMIT_PATH = '/ff874ef3172cbf4fd6ec2c5653a568e2';

/** 容器题接入信息；非交互题接口返回 []，归一化为 undefined */
export interface CompetitionConnection {
  docker_url?: string;
  docker_ip?: string;
  docker_port?: string;
  [key: string]: unknown;
}

export interface CompetitionQuestion {
  questionId: string;
  title: string;
  score: number;
  realScore: number;
  /** 无附件为空字符串 */
  fileUrl: string;
  isSolved: boolean;
  solvedNumber: number;
  category: string;
  attributes: string[];
  description: string;
  /** 接口返回 "true"/"false" 字符串，归一化为 boolean */
  interactive: boolean;
  capabilities: string[];
  connection: CompetitionConnection | undefined;
  extensions: Record<string, unknown>;
}

export interface SubmitOutcome {
  correct: boolean;
  message: string;
}

/** 平台返回 code !== 0，或 HTTP 层失败 */
export class CompetitionApiError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'CompetitionApiError';
    this.code = code;
  }
}

interface ApiEnvelope {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  data?: unknown;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function normalizeQuestion(raw: unknown): CompetitionQuestion {
  const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const connection = Array.isArray(q.connection) || q.connection === null ? undefined : q.connection;
  return {
    questionId: asString(q.question_id),
    title: asString(q.title),
    score: typeof q.score === 'number' ? q.score : 0,
    realScore: typeof q.real_score === 'number' ? q.real_score : 0,
    fileUrl: asString(q.file_url),
    isSolved: q.is_solved === true,
    solvedNumber: typeof q.solved_number === 'number' ? q.solved_number : 0,
    category: asString(q.category),
    attributes: asStringArray(q.attributes),
    description: asString(q.description),
    interactive: q.interactive === true || q.interactive === 'true',
    capabilities: asStringArray(q.capabilities),
    connection: connection as CompetitionConnection | undefined,
    extensions:
      typeof q.extensions === 'object' && q.extensions !== null && !Array.isArray(q.extensions)
        ? (q.extensions as Record<string, unknown>)
        : {},
  };
}

function parseEnvelope(body: string, url: string): ApiEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CompetitionApiError(`Competition API returned non-JSON response: ${url}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CompetitionApiError(`Competition API returned non-object response: ${url}`);
  }
  return parsed as ApiEnvelope;
}

/** code !== 0 视为平台拒绝（token 失效、题目不存在等），抛 CompetitionApiError */
function requireOk(envelope: ApiEnvelope, url: string): ApiEnvelope {
  const code = typeof envelope.code === 'number' ? envelope.code : undefined;
  if (code !== 0) {
    const message = asString(envelope.message, 'unknown error');
    throw new CompetitionApiError(
      `Competition API error (code ${code ?? '??'}): ${message} — ${url}`,
      code,
    );
  }
  return envelope;
}

export interface CompetitionClientOptions {
  /** 队伍 token，只允许来自环境变量（MISTY_CTF_TOKEN / CTF_TOKEN） */
  token: string;
  /** 默认 COMPETITION_API_BASE_URL */
  baseUrl?: string;
  /** 默认 DEFAULT_WEB_TIMEOUT_MS */
  timeoutMs?: number;
}

export class CompetitionClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: CompetitionClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? COMPETITION_API_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
  }

  async listQuestions(signal?: AbortSignal): Promise<CompetitionQuestion[]> {
    const url = `${this.baseUrl}${QUERY_PATH}?token=${encodeURIComponent(this.token)}`;
    const envelope = requireOk(await this.request(url, signal), url);
    const questions = Array.isArray(envelope.data) ? envelope.data : [];
    return questions.map(normalizeQuestion);
  }

  /** 仅容器题支持重置；静态题调用会收到平台的非 0 code */
  async resetEnvironment(questionId: string, signal?: AbortSignal): Promise<string> {
    const url =
      `${this.baseUrl}${RESET_PATH}?token=${encodeURIComponent(this.token)}` +
      `&question_id=${encodeURIComponent(questionId)}`;
    const envelope = requireOk(await this.request(url, signal), url);
    return asString(envelope.message, '操作成功');
  }

  /** flag 错误是正常结果（correct: false），只有平台拒绝才抛错 */
  async submitFlag(questionId: string, flag: string, signal?: AbortSignal): Promise<SubmitOutcome> {
    const url =
      `${this.baseUrl}${SUBMIT_PATH}?token=${encodeURIComponent(this.token)}` +
      `&question_id=${encodeURIComponent(questionId)}` +
      `&answer=${encodeURIComponent(flag)}`;
    const envelope = requireOk(await this.request(url, signal), url);
    const status = typeof envelope.status === 'number' ? envelope.status : undefined;
    const message = asString(envelope.message, status === 1 ? '答案正确' : '答案错误');
    return { correct: status === 1, message };
  }

  private async request(url: string, signal?: AbortSignal): Promise<ApiEnvelope> {
    let response: Response;
    try {
      response = await webGet(url, {
        timeoutMs: this.timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CompetitionApiError(`Competition API request aborted: ${url}`);
      }
      if (isTimeoutError(error)) {
        throw new CompetitionApiError(
          `Competition API request timed out (${Math.round(this.timeoutMs / 1000)}s): ${url}`,
        );
      }
      throw new CompetitionApiError(`Competition API request failed: ${errorMessage(error)} — ${url}`);
    }
    if (!response.ok) {
      throw new CompetitionApiError(
        `Competition API returned HTTP ${response.status} ${response.statusText}: ${url}`,
      );
    }
    return parseEnvelope(await response.text(), url);
  }
}
