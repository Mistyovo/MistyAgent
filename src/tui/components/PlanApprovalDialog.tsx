import { useState } from 'react';

import { Box, Text, useInput, useStdout } from 'ink';

import type { PlanApprovalReply, PlanApprovalRequest } from '#/core/plan-mode';

import { useTerminalTextWrap } from '../terminal-text';

export interface PlanApprovalDialogProps {
  request: PlanApprovalRequest;
  onReply(reply: PlanApprovalReply): void;
}

interface Option {
  approved: boolean;
  label: string;
}

/**
 * 计划正文的行数预算：可视高度减去弹窗框架（边框/标题/选项/提示 ≈7 行）
 * 与下方输入框+状态栏（≈5 行）的占用；无 TTY（测试）时按 24 行终端算。
 */
function planLineBudget(rows: number | undefined): number {
  return Math.max(6, (rows ?? 24) - 12);
}

/** 超长计划截断为前 N 行并补行数标记 */
export function truncatePlanLines(plan: string, maxLines: number): string {
  const lines = plan.split('\n');
  if (lines.length <= maxLines) {
    return plan;
  }
  return [...lines.slice(0, maxLines), `…（已截断，共 ${lines.length} 行）`].join('\n');
}

/**
 * 计划批准弹窗：显示 exit_plan_mode 提交的计划全文（超长截断），
 * 数字键 1/2 直接选择，←/→ 移动高亮，Enter 确认，Esc 拒绝（v1 不收反馈文本）。
 * 布局约束与 ApprovalDialog 一致（classic 边框、去右边框、内容过 wrap），
 * 理由见其实现注释（老式 conhost 歧义宽字符与 eraseLines 行数恒等）。
 */
export function PlanApprovalDialog({ request, onReply }: PlanApprovalDialogProps) {
  const options: Option[] = [
    { approved: true, label: 'Approve' },
    { approved: false, label: 'Reject' },
  ];
  const [selection, setSelection] = useState(0);
  const { stdout } = useStdout();
  const rows = (stdout as { rows?: number } | undefined)?.rows;
  const wrap = useTerminalTextWrap();

  useInput((input, key) => {
    if (key.escape) {
      onReply({ approved: false });
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
        onReply({ approved: option.approved });
      }
      return;
    }
    if (/^[12]$/.test(input)) {
      const option = options[Number(input) - 1];
      if (option !== undefined) {
        onReply({ approved: option.approved });
      }
    }
  });

  // 计划文本来自模型（上游不可控），一律 sanitize+物理折行后上屏
  const plan = truncatePlanLines(request.plan, planLineBudget(rows));
  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle="classic"
      borderColor="blue"
      borderRight={false}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color="blue">
        {wrap('计划待批准', 3)}
      </Text>
      <Text>{wrap(plan, 3)}</Text>
      {options.map((option, index) => (
        <Text key={option.label} {...(index === selection ? { color: 'cyan' as const } : {})}>
          {wrap(`${index === selection ? '❯' : ' '} ${index + 1}. ${option.label}`, 3)}
        </Text>
      ))}
      <Text dimColor>{wrap('1/2 直接选择，←/→ 移动，Enter 确认，Esc 拒绝', 3)}</Text>
    </Box>
  );
}
