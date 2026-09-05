import { render, type Instance } from 'ink';

import type { McpManager } from '#/core/mcp/manager';
import type { Session } from '#/core/session/session';
import type { ToolRegistry } from '#/core/tools/registry';

import { App } from './App';

export interface TuiDeps {
  session: Session;
  registry: ToolRegistry;
  model: string;
  cwd: string;
  mcpManager?: McpManager | undefined;
  /** /memory 信息来源；记忆未开启时缺省 */
  memoryInfo?: (() => string) | undefined;
  /** /skills 信息来源；无技能时缺省 */
  skillsInfo?: (() => string) | undefined;
  /** /rewind 检查点清单与回滚；检查点未启用时缺省 */
  rewind?: ((id?: string) => string) | undefined;
  /** /clear 开始新会话时的回调（清空任务级共享证据板）；print 模式缺省 */
  onNewSession?: (() => void) | undefined;
}

/** exitOnCtrlC 关闭：Ctrl+C 的双击退出语义由 App 自行处理 */
export function startTui(deps: TuiDeps): Instance {
  return render(
    <App
      session={deps.session}
      registry={deps.registry}
      model={deps.model}
      cwd={deps.cwd}
      mcpManager={deps.mcpManager}
      memoryInfo={deps.memoryInfo}
      skillsInfo={deps.skillsInfo}
      rewind={deps.rewind}
      onNewSession={deps.onNewSession}
    />,
    { exitOnCtrlC: false },
  );
}
