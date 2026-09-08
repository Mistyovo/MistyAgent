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
  /** 上下文用量（估算 tokens / 上限）；null 表示尚无边界事件触发过重算 */
  contextUsage?: { estimatedTokens: number; limit: number } | null;
  busy: boolean;
  /** 运行中的后台任务数，0 时不显示 */
  runningTasks: number;
  /** 第一次 Ctrl+C 后 3 秒内为 true，提示再按一次退出 */
  exitArmed: boolean;
}

export function formatTokenCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/**
 * 底部状态行（对齐 Claude Code / Kimi Code 的极简单行风格，无反色底）：
 * 左簇 basename · model · 权限模式，右簇 busy / 后台任务 / 上下文用量 /
 * token 用量 / 退出提示，中间空格填充。
 * 整行固定 列数-1 宽：满宽写在老式 conhost 会物理折行，与 ink 的行高预算错位，
 * eraseLines 逐帧少擦导致残帧。填充宽度必须自己按终端模式量
 * （measureTerminalWidth）：不能用 space-between——yoga 按 string-width
 * （歧义字符 1 格）定位右簇，legacy-cjk 下 ↑↓⚙… 物理占 2 格，右簇会整体
 * 超出预算折行。内容超宽时从 basename 截断。
 */
export const StatusBar = memo(function StatusBar({
  cwd,
  model,
  mode,
  usage,
  contextUsage,
  busy,
  runningTasks,
  exitArmed,
}: StatusBarProps) {
  const meta = permissionModeMeta[mode];
  const theme = getTheme();
  const widthMode = getTerminalWidthMode();
  const barWidth = useTerminalColumns() - 1;

  const modeText = `${meta.symbol} ${meta.label}`;
  const contextPct =
    contextUsage !== undefined && contextUsage !== null && contextUsage.limit > 0
      ? Math.min(999, Math.round((contextUsage.estimatedTokens / contextUsage.limit) * 100))
      : null;
  const contextText = contextPct === null ? '' : `  ctx ${contextPct}%`;
  const cachedText =
    usage?.cachedInputTokens !== undefined && usage.cachedInputTokens > 0
      ? ` cached ${formatTokenCount(usage.cachedInputTokens)}`
      : '';
  const usageText =
    usage === null
      ? ''
      : `  ↑${formatTokenCount(usage.inputTokens)}${cachedText} ↓${formatTokenCount(usage.outputTokens)}`;
  const tasksText = runningTasks > 0 ? `  ⚙ ${runningTasks}` : '';
  const busyText = busy ? '  …' : '';
  const exitText = exitArmed ? '  ctrl+c again to exit' : '';

  const basename = path.basename(cwd) || cwd;
  const tail = `${busyText}${tasksText}${contextText}${usageText}${exitText}`;
  const tailWidth = measureTerminalWidth(tail, widthMode);
  // basename 超宽时截断（保留 ' · ' 分隔），余量由中间填充吸收
  const budget =
    barWidth - measureTerminalWidth(` · ${model} · ${modeText}`, widthMode) - tailWidth;
  const basenameShown = truncateTerminalText(basename, Math.max(0, budget), widthMode);
  const lead = basenameShown === '' ? `${model} · ` : `${basenameShown} · ${model} · `;
  const fillWidth = Math.max(
    1,
    barWidth - measureTerminalWidth(`${lead}${modeText}`, widthMode) - tailWidth,
  );

  return (
    <Box marginTop={1} width={barWidth} flexDirection="row">
      <Text dimColor>{lead}</Text>
      <Text color={theme.permissionMode[mode]}>{modeText}</Text>
      <Text dimColor>{' '.repeat(fillWidth)}</Text>
      {busy && <Text dimColor>{busyText}</Text>}
      {runningTasks > 0 && <Text dimColor>{tasksText}</Text>}
      {contextPct !== null && (
        <Text
          color={contextPct >= 90 ? theme.error : contextPct >= 75 ? theme.warning : theme.dim}
        >
          {contextText}
        </Text>
      )}
      {usage !== null && <Text dimColor>{usageText}</Text>}
      {exitArmed && <Text color={theme.error}>{exitText}</Text>}
    </Box>
  );
});
