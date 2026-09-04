import { useState } from 'react';

import { Box, Text, useInput } from 'ink';

import { sessionRuleFor, type ApprovalReply, type ApprovalRequest } from '#/core/permission/approval';
import { describeRule, extractCommand, extractPath } from '#/core/permission/rules';

import { useTerminalTextWrap } from '../terminal-text';

export interface ApprovalDialogProps {
  request: ApprovalRequest;
  cwd: string;
  onReply(reply: ApprovalReply): void;
}

const MAX_DETAIL_LINES = 20;

function stringField(input: unknown, key: string): string | null {
  if (typeof input === 'object' && input !== null && key in input) {
    const value = (input as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function limitLines(lines: string[]): string[] {
  if (lines.length <= MAX_DETAIL_LINES) {
    return lines;
  }
  return [...lines.slice(0, MAX_DETAIL_LINES), `…（共 ${lines.length} 行，已截断）`];
}

/** 审批详情：bash 显示命令；write 显示路径+内容预览；edit 显示路径+old/new 预览；其余 JSON */
export function approvalDetailLines(request: ApprovalRequest): string[] {
  const { input } = request;
  if (request.toolName === 'bash') {
    const command = extractCommand(input);
    if (command !== null) {
      return limitLines(command.split('\n'));
    }
  }
  const path = extractPath(input);
  if (request.toolName === 'write') {
    const content = stringField(input, 'content');
    if (path !== null && content !== null) {
      return [`路径：${path}`, ...limitLines(content.split('\n'))];
    }
  }
  if (request.toolName === 'edit') {
    const oldText = stringField(input, 'old_string');
    const newText = stringField(input, 'new_string');
    if (path !== null && oldText !== null && newText !== null) {
      return [
        `路径：${path}`,
        ...limitLines([
          ...oldText.split('\n').map((line) => `- ${line}`),
          ...newText.split('\n').map((line) => `+ ${line}`),
        ]),
      ];
    }
  }
  let fallback: string;
  try {
    fallback = JSON.stringify(input, null, 2) ?? '';
  } catch {
    fallback = String(input);
  }
  return limitLines(fallback.split('\n'));
}

interface Option {
  decision: ApprovalReply['decision'];
  label: string;
}

/**
 * 审批弹窗：数字键 1/2/3 直接选择，←/→ 移动高亮，Enter 确认，Esc 拒绝。
 * 'always' 选项复用 M3 的 sessionRuleFor 展示会话级放行规则的粒度。
 */
export function ApprovalDialog({ request, cwd, onReply }: ApprovalDialogProps) {
  const options: Option[] = [
    { decision: 'once', label: 'Yes' },
    {
      decision: 'always',
      label: `Yes, and don't ask again for ${describeRule(sessionRuleFor(request, cwd))}`,
    },
    { decision: 'reject', label: 'No' },
  ];
  const [selection, setSelection] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onReply({ decision: 'reject' });
      return;
    }
    if (key.leftArrow) {
      setSelection((current) => (current + options.length - 1) % options.length);
      return;
    }
    if (key.rightArrow) {
      setSelection((current) => (current + 1) % options.length);
      return;
    }
    if (key.return) {
      const option = options[selection];
      if (option !== undefined) {
        onReply({ decision: option.decision });
      }
      return;
    }
    if (/^[123]$/.test(input)) {
      const option = options[Number(input) - 1];
      if (option !== undefined) {
        onReply({ decision: option.decision });
      }
    }
  });

  const detail = approvalDetailLines(request);
  // 内容宽度预算：左边框 1 格 + paddingX 左 1 格 + 1 格余量，reserve 3。
  // 命令/路径/文件内容都是上游不可控文本，sanitize+物理折行后才能进动态区。
  const wrap = useTerminalTextWrap();
  // 边框用 classic（ASCII + - |）：round/single 的 ─│╭ 等是 East Asian Ambiguous
  // 字符，在中文 cmd.exe 老式 conhost 按 2 格渲染，长内容时边框行物理换行，
  // 与 ink 行高预算错位会导致 eraseLines 残帧。
  // alignSelf flex-start：列容器里 Box 默认 stretch 到父宽（= 终端列数），
  // 满宽边框行在老式 conhost 立即折行 → 宽度收缩到内容。
  // borderRight 关闭：有右边框时短内容行会被 padding 空格撑到盒宽再跟 '|'，
  // 行内歧义字符（…… 等）的物理加宽把 '|' 推过列边界 → 物理折行。去掉右边框后
  // 行尾空格被 trimEnd，物理行宽只取决于内容本身。
  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle="classic"
      borderColor="yellow"
      borderRight={false}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color="yellow">
        {wrap(`需要审批：${request.describeCall}`, 3)}
      </Text>
      <Text dimColor>{wrap(request.reason, 3)}</Text>
      {detail.length > 0 && <Text dimColor>{wrap(detail.join('\n'), 3)}</Text>}
      {options.map((option, index) => (
        <Text key={option.decision} {...(index === selection ? { color: 'cyan' as const } : {})}>
          {wrap(`${index === selection ? '❯' : ' '} ${index + 1}. ${option.label}`, 3)}
        </Text>
      ))}
      <Text dimColor>{wrap('1/2/3 直接选择，←/→ 移动，Enter 确认，Esc 拒绝', 3)}</Text>
    </Box>
  );
}
