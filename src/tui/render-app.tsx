import { render, type Instance } from 'ink';

import type { Session } from '#/core/session/session';
import type { ToolRegistry } from '#/core/tools/registry';

import { App } from './App';

export interface TuiDeps {
  session: Session;
  registry: ToolRegistry;
  model: string;
  cwd: string;
}

/** exitOnCtrlC 关闭：Ctrl+C 的双击退出语义由 App 自行处理 */
export function startTui(deps: TuiDeps): Instance {
  return render(
    <App session={deps.session} registry={deps.registry} model={deps.model} cwd={deps.cwd} />,
    { exitOnCtrlC: false },
  );
}
