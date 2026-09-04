import path from 'node:path';

import picomatch from 'picomatch';

import type { PermissionRule } from '#/config/schema';

/** bash 工具的命令参数；非法 input 返回 null（不匹配任何带 pattern 的规则） */
export function extractCommand(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && 'command' in input) {
    const command = (input as { command: unknown }).command;
    if (typeof command === 'string') {
      return command.trim();
    }
  }
  return null;
}

/** read/write/edit/glob/grep 的路径参数；非法 input 返回 null */
export function extractPath(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && 'path' in input) {
    const inputPath = (input as { path: unknown }).path;
    if (typeof inputPath === 'string') {
      return inputPath;
    }
  }
  return null;
}

// 规则来自静态配置，同一 pattern 会反复匹配；连非法 pattern 的 null 也缓存，避免重复编译
const globCache = new Map<string, ((value: string) => boolean) | null>();

function compileGlob(pattern: string, nocase = false): ((value: string) => boolean) | null {
  const key = `${nocase}:${pattern}`;
  const cached = globCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: ((value: string) => boolean) | null;
  try {
    compiled = picomatch(pattern, { dot: true, nocase });
  } catch {
    compiled = null;
  }
  globCache.set(key, compiled);
  return compiled;
}

/** glob 元字符出现在规则 tool 字段时按 glob 匹配工具名（如 mcp__filesystem__*） */
const TOOL_GLOB_CHARS = /[*?[\]!(){}]/;

function matchToolName(ruleTool: string, toolName: string): boolean {
  if (!TOOL_GLOB_CHARS.test(ruleTool)) {
    return ruleTool.toLowerCase() === toolName.toLowerCase();
  }
  const isMatch = compileGlob(ruleTool, true);
  return isMatch !== null && isMatch(toolName);
}

function matchBashPattern(pattern: string, command: string): boolean {
  const isMatch = compileGlob(pattern);
  if (isMatch === null) {
    return false;
  }
  if (isMatch(command)) {
    return true;
  }
  // 前缀语义：'git *' 同时覆盖裸命令 'git'
  return pattern.endsWith(' *') && command === pattern.slice(0, -2);
}

function matchPathPattern(pattern: string, inputPath: string, cwd: string): boolean {
  const isMatch = compileGlob(pattern);
  if (isMatch === null) {
    return false;
  }
  const absolute = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(cwd, inputPath);
  // 相对候选匹配 'src/**' 类规则；绝对候选兼容规则里写绝对路径的情况
  const relative = path.relative(cwd, absolute).split(path.sep).join('/');
  const normalizedAbsolute = absolute.split(path.sep).join('/');
  return isMatch(relative) || isMatch(normalizedAbsolute);
}

/**
 * 规则匹配（对齐 Claude Code）：
 * - tool 名大小写不敏感：配置里习惯写 Claude Code 风格的 "Bash"，内置工具是小写；
 *   tool 字段含 glob 元字符时按 glob 匹配工具名（如 mcp__filesystem__* 放行整组 MCP 工具）
 * - 无 pattern：匹配该工具的全部调用
 * - bash：pattern 是命令前缀 glob，'git *' 覆盖 'git …' 与裸 'git'；
 *   精确 pattern（如 'git status'）只匹配该命令本身
 * - 其余工具：pattern 是文件路径 glob，取 input.path 相对 cwd 匹配
 */
export function matchRule(
  rule: PermissionRule,
  toolName: string,
  input: unknown,
  cwd: string,
): boolean {
  if (!matchToolName(rule.tool, toolName)) {
    return false;
  }
  if (rule.pattern === undefined) {
    return true;
  }
  if (toolName === 'bash') {
    const command = extractCommand(input);
    return command !== null && matchBashPattern(rule.pattern, command);
  }
  const inputPath = extractPath(input);
  return inputPath !== null && matchPathPattern(rule.pattern, inputPath, cwd);
}

/**
 * 查找指定 action 下第一条命中的规则（数组顺序先匹配优先）。
 * deny > ask > allow 的跨 action 优先级由 pipeline 按序调用本函数实现。
 */
export function findMatchingRule(
  rules: readonly PermissionRule[],
  action: PermissionRule['action'],
  toolName: string,
  input: unknown,
  cwd: string,
): PermissionRule | undefined {
  return rules.find(
    (rule) => rule.action === action && matchRule(rule, toolName, input, cwd),
  );
}

/** 展示用，如 Bash(git *)、Write(src/a.ts)、Read */
export function describeRule(rule: PermissionRule): string {
  return rule.pattern === undefined ? rule.tool : `${rule.tool}(${rule.pattern})`;
}
