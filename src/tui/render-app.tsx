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
    />,
    { exitOnCtrlC: false },
  );
}
