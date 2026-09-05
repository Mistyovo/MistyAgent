import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SkillDefinition } from './types';

export type SkillSource = SkillDefinition['source'];

export type ParseSkillResult =
  | { ok: true; definition: SkillDefinition }
  | { ok: false; warning: string };

export interface LoadSkillsOptions {
  /** 默认 ~/.misty/skills；测试可注入临时目录 */
  userSkillsDir?: string;
}

export interface LoadedSkills {
  definitions: SkillDefinition[];
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

/**
 * 解析一个技能定义文件：frontmatter（name/description 必填，when_to_use/argument-hint
 * 可选）+ 正文指令模板。失败返回 warning 而不是抛错——坏文件不阻断启动。
 */
export function parseSkillMarkdown(
  fileName: string,
  content: string,
  source: SkillSource,
): ParseSkillResult {
  const fail = (reason: string): ParseSkillResult => ({
    ok: false,
    warning: `技能定义 ${fileName} 已忽略：${reason}`,
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
    return fail(`技能 ${name} 缺少必填字段 description`);
  }
  const body = (match[2] ?? '').trim();
  if (body === '') {
    return fail(`技能 ${name} 的正文为空`);
  }
  const definition: SkillDefinition = { name, description, body, source };
  const whenToUse = scalar(fields['when_to_use']);
  if (whenToUse !== undefined) {
    definition.whenToUse = whenToUse;
  }
  const argumentHint = scalar(fields['argument-hint']);
  if (argumentHint !== undefined) {
    definition.argumentHint = argumentHint;
  }
  return { ok: true, definition };
}

/** 扫描 <dir>/<name>/SKILL.md 形态的技能目录；没有 SKILL.md 的子目录静默跳过 */
function loadDir(
  dir: string,
  source: SkillSource,
  into: Map<string, SkillDefinition>,
  warnings: string[],
): void {
  if (!existsSync(dir)) {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    warnings.push(`技能目录 ${dir} 不可读，已跳过`);
    return;
  }
  for (const entry of entries) {
    const file = join(dir, entry, 'SKILL.md');
    if (!existsSync(file)) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      warnings.push(`技能定义 ${file} 读取失败，已忽略`);
      continue;
    }
    const parsed = parseSkillMarkdown(file, content, source);
    if (parsed.ok) {
      into.set(parsed.definition.name, parsed.definition);
    } else {
      warnings.push(`${parsed.warning}（${dir}）`);
    }
  }
}

/**
 * 加载技能定义：先 user 级（~/.misty/skills/<name>/SKILL.md）后项目级
 * （<cwd>/.misty/skills/<name>/SKILL.md），项目级同名覆盖 user 级。
 * 目录不存在静默跳过；单个文件损坏降级为 warning。
 */
export function loadSkillDefinitions(
  cwd: string,
  options: LoadSkillsOptions = {},
): LoadedSkills {
  const warnings: string[] = [];
  const definitions = new Map<string, SkillDefinition>();
  loadDir(
    options.userSkillsDir ?? join(homedir(), '.misty', 'skills'),
    'user',
    definitions,
    warnings,
  );
  loadDir(join(cwd, '.misty', 'skills'), 'project', definitions, warnings);
  return { definitions: [...definitions.values()], warnings };
}
