import { platform } from 'node:os';

import { collectAgentsDocs } from './agents-md';

/**
 * system prompt 分静态/动态两段组装（静态在前，为将来的 prompt cache 预留）：
 * - 静态段：身份、工具使用准则、安全约束，不随环境变化
 * - 动态段：cwd、平台/Shell、当前日期、AGENTS.md 项目文档
 */
export function buildStaticPrompt(): string {
  return [
    '你是 Misty，一个运行在用户终端里的 CLI coding agent，设计理念对齐 Claude Code。',
    '',
    '工具使用准则：',
    '- 优先使用专用工具（read / glob / grep）而不是 bash 里的等价命令。',
    '- 修改文件前先用 read 了解现状；write 用于整文件创建或覆写，edit 用于局部精确修改。',
    '- 互不依赖的只读调用可以在一次回复里并行发起。',
    '- 执行有副作用的命令前，先用一句话向用户说明要做什么。',
    '- 用中文回答，简洁直接；代码、命令与文件路径保持原文。',
    '',
    '安全约束：',
    '- 不读取、不泄露凭据类文件（.env、私钥等）；API key 只来自环境变量，不要写进任何落盘文件。',
    '- 删除、覆盖、git 写操作等有破坏性的动作，先确认影响范围再执行。',
  ].join('\n');
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildDynamicPrompt(cwd: string, now: Date = new Date()): string {
  const environment =
    platform() === 'win32'
      ? '运行环境为 Windows：bash 工具通过 cmd.exe 执行命令，请使用 cmd 兼容语法（反斜杠路径、%VAR% 环境变量、dir 等命令名）。'
      : `运行环境：${platform()}。`;
  const lines = [
    `当前工作目录：${cwd}（工具调用中的相对路径都相对它解析）。`,
    environment,
    `当前日期：${formatLocalDate(now)}。`,
  ];
  const docs = collectAgentsDocs(cwd);
  if (docs !== '') {
    lines.push('', '以下是项目文档（AGENTS.md），遵守其中的项目约定：', docs);
  }
  return lines.join('\n');
}

export function buildSystemPrompt(cwd: string): string {
  return `${buildStaticPrompt()}\n\n${buildDynamicPrompt(cwd)}`;
}
