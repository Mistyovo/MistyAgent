import type { ReactNode } from 'react';

import { Box, Text } from 'ink';

import { getTerminalWidthMode, useTerminalTextWrap } from '../terminal-text';
import { getTheme } from '../theme';

export interface DialogFrameProps {
  /** 弹窗标题（加粗、着边框色） */
  title: string;
  /** 标题与边框颜色（传主题语义色，如 theme.warning / theme.accent） */
  color: string;
  children: ReactNode;
}

/**
 * 弹窗公共框架（圆角边框 + 标题行 + 统一宽度约束）：
 * - narrow 终端（现代终端，East Asian Ambiguous 按 1 格渲染）：ink round 边框
 *   （╭─╮│╰╯），歧义字符物理宽度与 ink 预算一致，完整四边安全
 * - legacy-cjk 终端（中文 cmd.exe 老式 conhost，歧义字符 2 格）：回退 classic
 *   ASCII 边框（+ - |），且关闭右边框——有右边框时短内容行被 padding 撑到盒宽
 *   再跟 '|'，行内歧义字符的物理加宽会把 '|' 推过列边界 → 物理折行残帧
 * - 内容宽度预算：边框 1 格 + paddingX 1 格 + 1 格余量，reserve 3；
 *   弹窗内文本均为上游不可控（命令/模型输出），一律 sanitize+物理折行
 * - alignSelf flex-start：列容器里 Box 默认 stretch 到父宽（= 终端列数），
 *   满宽边框行会立即折行，宽度收缩到内容
 */
export function DialogFrame({ title, color, children }: DialogFrameProps) {
  const wrap = useTerminalTextWrap();
  const narrow = getTerminalWidthMode() === 'narrow';
  const borderStyle = narrow ? 'round' : 'classic';
  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      borderStyle={borderStyle}
      borderColor={color}
      {...(narrow ? {} : { borderRight: false })}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={color}>
        {wrap(title, 3)}
      </Text>
      {children}
    </Box>
  );
}

/** 弹窗选项行的公共渲染：选中项 ❯ 前缀 + accent 高亮，未选中 dim */
export function DialogOption({
  selected,
  index,
  label,
  reserve = 3,
}: {
  selected: boolean;
  index: number;
  label: string;
  reserve?: number;
}) {
  const wrap = useTerminalTextWrap();
  const theme = getTheme();
  return (
    <Text {...(selected ? { color: theme.accent } : { dimColor: true })}>
      {wrap(`${selected ? '❯' : ' '} ${index + 1}. ${label}`, reserve)}
    </Text>
  );
}
