import type { ToolSchema } from "../agent/types.js";
import type { TaskStore } from "../agent/tasks.js";

export interface ToolContext {
  /** Sandbox root — all file operations must resolve inside this directory. */
  projectDir: string;
  /** Present when task tracking is enabled; used by the task_update tool. */
  taskStore?: TaskStore;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

export function toSchema(tool: Tool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
