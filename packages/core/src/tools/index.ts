import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file/index.js";
import { cliTools } from "./cli/index.js";
import { dbTools } from "./db/index.js";
import { sshTools } from "./ssh/index.js";
import { taskTools } from "./task/index.js";
import { excelTools } from "./excel/index.js";

export * from "./base.js";
export { ToolRegistry } from "./registry.js";
export { fileTools } from "./file/index.js";
export { cliTools } from "./cli/index.js";
export { dbTools } from "./db/index.js";
export { sshTools } from "./ssh/index.js";
export { taskTools } from "./task/index.js";
export { excelTools } from "./excel/index.js";

export interface RegistryOptions {
  /** Register the task_update checklist tool (default false). */
  tasks?: boolean;
  /** Register filesystem + shell tools (file ops, exec). Disable when the
   * session has no working directory so the agent can't touch the local disk.
   * db/ssh/task tools remain available regardless. Default true. */
  filesystem?: boolean;
}

export function createDefaultRegistry(opts: RegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const tools: import("./base.js").Tool[] = [];
  if (opts.filesystem !== false) {
    tools.push(...fileTools, ...cliTools, ...excelTools);
  }
  tools.push(...dbTools, ...sshTools);
  if (opts.tasks) tools.push(...taskTools);
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}
