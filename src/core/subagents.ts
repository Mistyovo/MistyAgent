import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 自定义子代理定义（.misty/agents/*.md）：frontmatter 元信息 + 正文 system prompt */
export interface SubagentDefinition {
  /** 必填，成为 agent 工具 subagent_type 的取值 */
  name: string;
  /** 必填，模型选择子代理的依据 */
  description: string;
  /** 工具白名单（frontmatter 逗号分隔或 dash 列表）；缺省只读三件套 read/glob/grep */
  tools?: string[] | undefined;
  /** 覆盖默认模型 */
  model?: string | undefined;
  /** 正文全文，作为子代理 system prompt 的角色段 */
  prompt: string;
}

export type ParseSubagentResult =
  | { ok: true; definition: SubagentDefinition }
  | { ok: false; warning: string };

export interface LoadSubagentsOptions {
  /** 默认 ~/.misty/agents；测试可注入临时目录 */
  userAgentsDir?: string;
}

export interface LoadedSubagents {
  definitions: SubagentDefinition[];
  warnings: string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 极简 frontmatter 解析（项目不引 yaml 依赖）：只支持 `key: value` 标量与
 * `key:` 后跟 `  - item` 的 dash 列表；无法识别的行忽略（容错优先）。
 */
function parseFrontmatter(text: string): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  let pendingListKey: string | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const listItem = /^\s+-\s+(.*)$/.exec(line);
    if (listItem !== null && pendingListKey !== null) {
      const list = fields[pendingListKey];
      if (Array.isArray(list)) {
        list.push(unquote(listItem[1]!.trim()));
      }
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) {
      pendingListKey = null;
      continue;
    }
    const [, key, value] = pair;
    if (value === undefined || value.trim() === '') {
      fields[key!] = [];
      pendingListKey = key!;
    } else {
      fields[key!] = unquote(value.trim());
      pendingListKey = null;
    }
  }
  return fields;
}

function scalar(field: string | string[] | undefined): string | undefined {
  if (typeof field !== 'string') {
    return undefined;
  }
  const trimmed = field.trim();
  return trimmed === '' ? undefined : trimmed;
}

function stringList(field: string | string[] | undefined): string[] | undefined {
  if (field === undefined) {
    return undefined;
  }
  const items = Array.isArray(field) ? field : field.split(',');
  const list = items.map((item) => item.trim()).filter((item) => item !== '');
  return list.length > 0 ? list : undefined;
}

/**
 * 解析一个子代理定义文件：frontmatter（name/description 必填，tools/model 可选）
 * + 正文 system prompt。失败返回 warning 而不是抛错——坏文件不阻断启动。
 */
export function parseSubagentMarkdown(fileName: string, content: string): ParseSubagentResult {
  const fail = (reason: string): ParseSubagentResult => ({
    ok: false,
    warning: `子代理定义 ${fileName} 已忽略：${reason}`,
  });
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) {
    return fail('缺少 frontmatter（文件须以 --- 包裹的元信息开头）');
  }
  const fields = parseFrontmatter(match[1]!);
  const name = scalar(fields['name']);
  if (name === undefined) {
    return fail('frontmatter 缺少必填字段 name');
  }
  if (!NAME_PATTERN.test(name)) {
    return fail(`name "${name}" 不合法（只允许字母/数字/连字符/下划线，字母开头）`);
  }
  const description = scalar(fields['description']);
  if (description === undefined) {
    return fail(`子代理 ${name} 缺少必填字段 description`);
  }
  const prompt = (match[2] ?? '').trim();
  if (prompt === '') {
    return fail(`子代理 ${name} 的正文（system prompt）为空`);
  }
  const definition: SubagentDefinition = { name, description, prompt };
  const tools = stringList(fields['tools']);
  if (tools !== undefined) {
    definition.tools = tools;
  }
  const model = scalar(fields['model']);
  if (model !== undefined) {
    definition.model = model;
  }
  return { ok: true, definition };
}

function loadDir(
  dir: string,
  into: Map<string, SubagentDefinition>,
  warnings: string[],
): void {
  if (!existsSync(dir)) {
    return;
  }
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .toSorted();
  } catch {
    warnings.push(`子代理目录 ${dir} 不可读，已跳过`);
    return;
  }
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(dir, file), 'utf8');
    } catch {
      warnings.push(`子代理定义 ${join(dir, file)} 读取失败，已忽略`);
      continue;
    }
    const parsed = parseSubagentMarkdown(file, content);
    if (parsed.ok) {
      into.set(parsed.definition.name, parsed.definition);
    } else {
      warnings.push(`${parsed.warning}（${dir}）`);
    }
  }
}

/**
 * 加载自定义子代理：先 user 级（~/.misty/agents）后项目级（<cwd>/.misty/agents），
 * 项目级同名覆盖 user 级。目录不存在静默跳过；单个文件损坏降级为 warning。
 */
export function loadSubagentDefinitions(
  cwd: string,
  options: LoadSubagentsOptions = {},
): LoadedSubagents {
  const warnings: string[] = [];
  const definitions = new Map<string, SubagentDefinition>();
  loadDir(options.userAgentsDir ?? join(homedir(), '.misty', 'agents'), definitions, warnings);
  loadDir(join(cwd, '.misty', 'agents'), definitions, warnings);
  return { definitions: [...definitions.values()], warnings };
}
