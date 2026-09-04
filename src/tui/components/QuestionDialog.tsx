import { useState } from 'react';

import { Box, Text, useInput } from 'ink';

import type { QuestionReply, QuestionRequest } from '#/core/question';

import { useTerminalTextWrap } from '../terminal-text';

export interface QuestionDialogProps {
  request: QuestionRequest;
  onReply(reply: QuestionReply): void;
}

/**
 * 提问弹窗：数字键 1-4 直选（多选时等效空格勾选），↑/↓ 移动高亮；
 * 单选 Enter 直接确认，多选 Enter 确认所有勾选项；Esc 跳过（cancelled）。
 * 布局约束与 ApprovalDialog 一致（classic 边框、去右边框、内容过 wrap），
 * 理由见其实现注释（老式 conhost 歧义宽字符与 eraseLines 行数恒等）。
 */
export function QuestionDialog({ request, onReply }: QuestionDialogProps) {
  const multi = request.multiSelect === true;
  const options = request.options;
  const [selection, setSelection] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const wrap = useTerminalTextWrap();

  const toggle = (index: number): void => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const confirmMulti = (marks: ReadonlySet<number>): void => {
    const answers = options.flatMap((option, index) => (marks.has(index) ? [option.label] : []));
    onReply({ answers });
  };

  useInput((input, key) => {
    if (key.escape) {
      onReply({ cancelled: true });
      return;
    }
    if (key.upArrow) {
      setSelection((current) => (current + options.length - 1) % options.length);
      return;
    }
    if (key.downArrow) {
      setSelection((current) => (current + 1) % options.length);
      return;
    }
    if (multi && input === ' ') {
      toggle(selection);
      return;
    }
    if (key.return) {
      if (multi) {
        confirmMulti(checked);
      } else {
        const option = options[selection];
        if (option !== undefined) {
          onReply({ answers: [option.label] });
        }
      }
      return;
    }
    if (/^[1-4]$/.test(input)) {
      const index = Number(input) - 1;
      const option = options[index];
      if (option === undefined) {
        return;
      }
      if (multi) {
        toggle(index);
      } else {
        onReply({ answers: [option.label] });
      }
    }
  });

  const hint = multi
    ? '空格/1-4 勾选，↑/↓ 移动，Enter 确认，Esc 跳过'
    : '1-4 直选，↑/↓ 移动，Enter 确认，Esc 跳过';
  // 问题与选项文案来自模型（上游不可控），一律 sanitize+物理折行后上屏
  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle="classic"
      borderColor="cyan"
      borderRight={false}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color="cyan">
        {wrap(`提问：${request.question}`, 3)}
      </Text>
      {options.map((option, index) => {
        const mark = multi ? (checked.has(index) ? '[x] ' : '[ ] ') : '';
        const description =
          option.description !== undefined && option.description !== ''
            ? ` — ${option.description}`
            : '';
        return (
          <Text key={`${index}:${option.label}`} {...(index === selection ? { color: 'cyan' as const } : {})}>
            {wrap(`${index === selection ? '❯' : ' '} ${index + 1}. ${mark}${option.label}${description}`, 3)}
          </Text>
        );
      })}
      <Text dimColor>{wrap(hint, 3)}</Text>
    </Box>
  );
}
