import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file/index.js";
import { cliTools } from "./cli/index.js";
import { dbTools } from "./db/index.js";
import { sshTools } from "./ssh/index.js";
import { taskTools } from "./task/index.js";
import { excelTools } from "./excel/index.js";
import { webTools } from "./web/index.js";

export * from "./base.js";
export { ToolRegistry } from "./registry.js";
export { fileTools } from "./file/index.js";
export { cliTools } from "./cli/index.js";
export { dbTools } from "./db/index.js";
export { sshTools } from "./ssh/index.js";
export { taskTools } from "./task/index.js";
export { excelTools } from "./excel/index.js";
export { webTools } from "./web/index.js";

export interface RegistryOptions {
  /** Register the task_update checklist tool (default false). When true,
   * task_update is ALWAYS registered — it bypasses `enabledTools` because it's
   * the task-checklist feature flag, not a per-tool toggle. */
  tasks?: boolean;
  /** Register filesystem + shell tools (file ops, exec). Disable when the
   * session has no working directory so the agent can't touch the local disk.
   * When false, file/exec/excel tools are hard-stripped regardless of
   * `enabledTools` (they need the project sandbox to function). Default true. */
  filesystem?: boolean;
  /**
   * Which tool names to register. Defaults to the 5 file operations only
   * (`DEFAULT_ENABLED_TOOLS`). exec / db_query / ssh_exec / sftp /
   * read_excel / write_excel default OFF — opt in via settings/env to keep the
   * prompt lean and the blast radius small. `task_update` ignores this filter
   * (it's gated by `tasks`).
   */
  enabledTools?: Set<string>;
}

/**
 * Tools enabled by default: the five file operations. Everything else (exec,
 * db_query, ssh, excel) is opt-in so the prompt stays small and dangerous
 * tools are off until the user explicitly turns them on.
 */
export const DEFAULT_ENABLED_TOOLS = new Set<string>([
  "read_file",
  "write_file",
  "edit_file",
  "copy_file",
  "list_dir",
]);

export function createDefaultRegistry(opts: RegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const enabled = opts.enabledTools ?? DEFAULT_ENABLED_TOOLS;
  const hasFs = opts.filesystem !== false;

  // file / exec / excel tools require the project sandbox (workdir). Register
  // only those the user enabled AND only when a workdir exists.
  const fsCandidates = [...fileTools, ...cliTools, ...excelTools];
  for (const tool of fsCandidates) {
    if (hasFs && enabled.has(tool.name)) registry.register(tool);
  }
  // db / ssh / web tools don't need a workdir — register by user preference only.
  for (const tool of [...dbTools, ...sshTools, ...webTools]) {
    if (enabled.has(tool.name)) registry.register(tool);
  }
  // task_update bypasses enabledTools — it's controlled solely by `tasks`.
  if (opts.tasks) {
    for (const tool of taskTools) registry.register(tool);
  }
  return registry;
}
