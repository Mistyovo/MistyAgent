import { ToolRegistry } from '../registry';
import type { Tool } from '../tool';

import { bashTool } from './bash';
import { editTool } from './edit';
import { globTool } from './glob';
import { grepTool } from './grep';
import { readTool } from './read';
import { writeTool } from './write';

export const builtinTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
];

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtinTools) {
    registry.register(tool);
  }
  return registry;
}
