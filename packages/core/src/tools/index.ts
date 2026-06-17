import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file/index.js";
import { cliTools } from "./cli/index.js";
import { dbTools } from "./db/index.js";
import { sshTools } from "./ssh/index.js";
import { taskTools } from "./task/index.js";

export * from "./base.js";
export { ToolRegistry } from "./registry.js";
export { fileTools } from "./file/index.js";
export { cliTools } from "./cli/index.js";
export { dbTools } from "./db/index.js";
export { sshTools } from "./ssh/index.js";
export { taskTools } from "./task/index.js";

export interface RegistryOptions {
  /** Register the task_update checklist tool (default false). */
  tasks?: boolean;
}

export function createDefaultRegistry(opts: RegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const tools = [...fileTools, ...cliTools, ...dbTools, ...sshTools];
  if (opts.tasks) tools.push(...taskTools);
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}
