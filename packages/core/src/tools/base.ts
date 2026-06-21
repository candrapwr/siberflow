import type { ToolSchema } from "../agent/types.js";
import type { TaskStore } from "../agent/tasks.js";

export interface ToolContext {
  /** Sandbox root — all file operations must resolve inside this directory. */
  projectDir: string;
  /** Present when task tracking is enabled; used by the task_update tool. */
  taskStore?: TaskStore;
  /**
   * Optional extra directory that `read_excel` may read uploaded files from
   * (typically an OS tmp dir scoped per session, so the project folder stays
   * clean). Only `read_excel` honors this field — every other file tool stays
   * sandboxed to `projectDir` and never sees uploaded files.
   */
  uploadDir?: string;
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
