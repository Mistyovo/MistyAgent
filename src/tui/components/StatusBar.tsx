import path from 'node:path';

import { memo } from 'react';

import { Box, Text } from 'ink';

import type { PermissionMode } from '#/config/schema';
import { permissionModeMeta } from '#/core/permission/modes';
import type { TokenUsage } from '#/provider/types';

import {
  getTerminalWidthMode,
  measureTerminalWidth,
  truncateTerminalText,
  useTerminalColumns,
} from '../terminal-text';

export interface StatusBarProps {
  cwd: string;
  model: string;
  mode: PermissionMode;
  /** 上一个 turn 的累计用量；null 表示还没有完成的 turn */
  usage: TokenUsage | null;
  busy: boolean;
  /** 运行中的后台任务数，0 时不显示 */
  runningTasks: number;
  /** 第一次 Ctrl+C 后 3 秒内为 true，提示再按一次退出 */
  exitArmed: boolean;
}

export function formatTokenCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** 底栏：cwd basename · 模型 · 权限模式（M3 元数据的符号+颜色）· token 用量。
 *  不画边框线：box-drawing 字符（─│ 等 East Asian Ambiguous）在中文 cmd.exe
 *  老式 conhost 里按 2 格渲染，满宽边框行会物理换行、与 ink 的行高预算错位，
 *  eraseLines 逐帧少擦导致残帧/空白累积。整行物理宽度按 列数-2 预算
 *  （-1 满宽保险、-1 paddingX 左格），余量不够时从 basename 截断。 */
export const StatusBar = memo(function StatusBar({
  cwd,
  model,
  mode,
  usage,
  busy,
  runningTasks,
  exitArmed,
}: StatusBarProps) {
  const meta = permissionModeMeta[mode];
  const basename = path.basename(cwd) || cwd;
  const widthMode = getTerminalWidthMode();
  const budget = useTerminalColumns() - 2;
  const tail =
    `  ${model}  ${meta.symbol} ${meta.label}` +
    (busy ? '  …' : '') +
    (runningTasks > 0 ? `  ⚙ ${runningTasks}` : '') +
    (usage === null
      ? ''
      : `  ↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)}`) +
    (exitArmed ? '  再按一次 Ctrl+C 退出' : '');
  const basenameWidth = Math.max(0, budget - measureTerminalWidth(tail, widthMode));
  const basenameShown = truncateTerminalText(basename, basenameWidth, widthMode);
  return (
    <Box marginTop={1} paddingX={1}>
      {basenameShown !== '' && <Text dimColor>{basenameShown}</Text>}
      <Text dimColor>{`  ${model}  `}</Text>
      <Text color={meta.color}>{`${meta.symbol} ${meta.label}`}</Text>
      {busy && <Text dimColor>{'  …'}</Text>}
      {runningTasks > 0 && <Text dimColor>{`  ⚙ ${runningTasks}`}</Text>}
      {usage !== null && (
        <Text dimColor>{`  ↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)}`}</Text>
      )}
      {exitArmed && <Text color="red">{'  再按一次 Ctrl+C 退出'}</Text>}
    </Box>
  );
});
