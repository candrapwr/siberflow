import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file/index.js";
import { cliTools } from "./cli/index.js";

export * from "./base.js";
export { ToolRegistry } from "./registry.js";
export { fileTools } from "./file/index.js";
export { cliTools } from "./cli/index.js";

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [...fileTools, ...cliTools]) {
    registry.register(tool);
  }
  return registry;
}
