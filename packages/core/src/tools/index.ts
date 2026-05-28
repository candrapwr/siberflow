import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file/index.js";
import { cliTools } from "./cli/index.js";
import { taskTools } from "./task/index.js";

export * from "./base.js";
export { ToolRegistry } from "./registry.js";
export { fileTools } from "./file/index.js";
export { cliTools } from "./cli/index.js";
export { taskTools } from "./task/index.js";

export interface RegistryOptions {
  /** Register the task_update checklist tool (default false). */
  tasks?: boolean;
}

export function createDefaultRegistry(opts: RegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const tools = [...fileTools, ...cliTools];
  if (opts.tasks) tools.push(...taskTools);
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}
