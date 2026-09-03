import path from 'node:path';

import { Box, Text } from 'ink';

import type { PermissionMode } from '#/config/schema';
import { permissionModeMeta } from '#/core/permission/modes';
import type { TokenUsage } from '#/provider/types';

export interface StatusBarProps {
  cwd: string;
  model: string;
  mode: PermissionMode;
  /** 上一个 turn 的累计用量；null 表示还没有完成的 turn */
  usage: TokenUsage | null;
  busy: boolean;
  /** 第一次 Ctrl+C 后 3 秒内为 true，提示再按一次退出 */
  exitArmed: boolean;
}

export function formatTokenCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** 底栏：cwd basename · 模型 · 权限模式（M3 元数据的符号+颜色）· token 用量 */
export function StatusBar({ cwd, model, mode, usage, busy, exitArmed }: StatusBarProps) {
  const meta = permissionModeMeta[mode];
  const basename = path.basename(cwd) || cwd;
  return (
    <Box borderTop borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text dimColor>{basename}</Text>
      <Text dimColor>{`  ${model}  `}</Text>
      <Text color={meta.color}>{`${meta.symbol} ${meta.label}`}</Text>
      {busy && <Text dimColor>{'  …'}</Text>}
      {usage !== null && (
        <Text dimColor>{`  ↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)}`}</Text>
      )}
      {exitArmed && <Text color="red">{'  再按一次 Ctrl+C 退出'}</Text>}
    </Box>
  );
}
