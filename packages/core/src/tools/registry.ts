import type { Tool, ToolContext } from "./base.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(
    name: string,
    rawArgs: string,
    ctx: ToolContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: tool "${name}" not found`;
    }
    let args: unknown;
    try {
      args = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch (err) {
      return `Error: invalid JSON arguments — ${(err as Error).message}`;
    }
    try {
      return await tool.execute(args, ctx);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }
}
