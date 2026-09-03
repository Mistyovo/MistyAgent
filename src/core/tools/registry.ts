import type { ToolDefinition } from '#/provider/types';

import type { Tool } from './tool';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重复注册：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list().map((tool) => tool.toJSONSchema());
  }
}
