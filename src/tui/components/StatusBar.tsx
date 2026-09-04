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
import { getTheme } from '../theme';

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

/** 反色底栏：左簇 basename / 模型 / 权限模式（符号/文案取自模式元数据，颜色取自主题），
 *  右簇 busy / 后台任务 / token 用量 / 退出提示，中间空格填充。
 *  整行固定 列数-1 宽：满宽写在老式 conhost 会物理折行，与 ink 的行高预算错位，
 *  eraseLines 逐帧少擦导致残帧。背景由外层 Box 的 backgroundColor 整行填充
 *  （含 padding 与空隙），子 Text 经 backgroundContext 继承同色底。
 *  填充宽度必须自己按终端模式量（measureTerminalWidth）：不能用 space-between——
 *  yoga 按 string-width（歧义字符 1 格）定位右簇，legacy-cjk 下 ↑↓⚙… 物理占 2 格，
 *  右簇会整体超出预算折行。内容超宽时从 basename 截断；不画边框线（同根因）。 */
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
  const theme = getTheme();
  const widthMode = getTerminalWidthMode();
  const barWidth = useTerminalColumns() - 1;
  const contentBudget = barWidth - 2; // paddingX 左右各 1

  const modeText = `${meta.symbol} ${meta.label}`;
  const tail =
    (busy ? '  …' : '') +
    (runningTasks > 0 ? `  ⚙ ${runningTasks}` : '') +
    (usage === null
      ? ''
      : `  ↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)}`);
  const exitText = exitArmed ? '  再按一次 Ctrl+C 退出' : '';

  const basename = path.basename(cwd) || cwd;
  const fixedWidth = measureTerminalWidth(`${model}  ${modeText}${tail}${exitText}`, widthMode);
  // basename 后还有 2 格间隔；截断为空时间隔一并省略，余量由中间填充吸收
  const basenameShown = truncateTerminalText(
    basename,
    Math.max(0, contentBudget - fixedWidth - 2),
    widthMode,
  );
  const head = basenameShown === '' ? model : `${basenameShown}  ${model}`;
  const fillWidth = Math.max(
    0,
    contentBudget -
      measureTerminalWidth(`${head}  ${modeText}`, widthMode) -
      measureTerminalWidth(`${tail}${exitText}`, widthMode),
  );

  return (
    <Box marginTop={1} width={barWidth} paddingX={1} backgroundColor={theme.statusBarBg}>
      <Text color={theme.statusBar}>{`${head}  `}</Text>
      <Text color={theme.permissionMode[mode]}>{modeText}</Text>
      {fillWidth > 0 && <Text>{' '.repeat(fillWidth)}</Text>}
      {busy && <Text color={theme.statusBar}>{'  …'}</Text>}
      {runningTasks > 0 && <Text color={theme.statusBar}>{`  ⚙ ${runningTasks}`}</Text>}
      {usage !== null && (
        <Text color={theme.statusBar}>{`  ↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)}`}</Text>
      )}
      {exitArmed && <Text color={theme.error}>{exitText}</Text>}
    </Box>
  );
});
