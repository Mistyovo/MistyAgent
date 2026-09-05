import { extractPath } from '../permission/rules';
import { resolvePath } from '../tools/builtin/fs-utils';
import type { Tool } from '../tools/tool';

import type { CheckpointStore } from './checkpoint';

/**
 * 写类工具包装：call 前把目标文件快照进当前 pending checkpoint。
 * 只覆写 call，describeCall/isReadOnly/accesses 等其余属性透传；
 * 快照抛错照常委托原调用，不阻断工具执行。
 */
export function withCheckpoint(tool: Tool, store: CheckpointStore): Tool {
  return {
    ...tool,
    call: async (input, ctx) => {
      try {
        const inputPath = extractPath(input);
        if (inputPath !== null) {
          store.snapshotBeforeWrite(resolvePath(store.cwd, inputPath));
        }
      } catch {
        // 快照异常不阻断工具执行
      }
      return tool.call(input, ctx);
    },
  };
}
