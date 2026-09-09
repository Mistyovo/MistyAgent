import { useState } from 'react';

import { Box, Text, useInput } from 'ink';

import { sessionRuleFor, type ApprovalReply, type ApprovalRequest } from '#/core/permission/approval';
import { describeRule, extractCommand, extractPath } from '#/core/permission/rules';

import { useTerminalTextWrap } from '../terminal-text';
import { getTheme, type Theme } from '../theme';

import { DialogFrame, DialogOption } from './DialogFrame';

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
  return [...lines.slice(0, MAX_DETAIL_LINES), `… (${lines.length} lines, truncated)`];
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
      return [`path: ${path}`, ...limitLines(content.split('\n'))];
    }
  }
  if (request.toolName === 'edit') {
    const oldText = stringField(input, 'old_string');
    const newText = stringField(input, 'new_string');
    if (path !== null && oldText !== null && newText !== null) {
      return [
        `path: ${path}`,
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

/** edit 审批的 -/+ 预览行着色；其余工具详情保持 dim */
function diffLineColor(toolName: string, line: string, theme: Theme): string | null {
  if (toolName !== 'edit') {
    return null;
  }
  if (line.startsWith('-')) {
    return theme.markdown.diffRemove;
  }
  if (line.startsWith('+')) {
    return theme.markdown.diffAdd;
  }
  return null;
}

/**
 * 审批弹窗：数字键 1/2/3 直接选择，←/→ 移动高亮，Enter 确认，Esc 拒绝。
 * 'always' 选项复用 sessionRuleFor 展示会话级放行规则的粒度。
 */
export function ApprovalDialog({ request, cwd, onReply }: ApprovalDialogProps) {
  const options: Option[] = [
    { decision: 'once', label: 'Allow once' },
    {
      decision: 'always',
      label: `Always allow ${describeRule(sessionRuleFor(request, cwd))} this session`,
    },
    { decision: 'reject', label: 'Deny (esc)' },
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
  const theme = getTheme();
  const wrap = useTerminalTextWrap();
  return (
    <DialogFrame title={`Allow ${request.describeCall}?`} color={theme.warning}>
      <Text dimColor>{wrap(request.reason, 3)}</Text>
      {detail.length > 0 && (
        <Box flexDirection="column">
          {detail.map((line, index) => {
            const color = diffLineColor(request.toolName, line, theme);
            return (
              <Text key={index} {...(color === null ? { dimColor: true } : { color })}>
                {wrap(line, 3)}
              </Text>
            );
          })}
        </Box>
      )}
      {options.map((option, index) => (
        <DialogOption
          key={option.decision}
          selected={index === selection}
          index={index}
          label={option.label}
        />
      ))}
      <Text dimColor>{wrap('1-3 choose · ←→ move · enter ok · esc deny', 3)}</Text>
    </DialogFrame>
  );
}
