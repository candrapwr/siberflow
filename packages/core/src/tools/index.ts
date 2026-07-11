import type { Provider } from "../providers/base.js";
import { ToolRegistry } from "./registry.js";
import { fileTools } from "./file/index.js";
import { cliTools } from "./cli/index.js";
import { dbTools } from "./db/index.js";
import { sshTools } from "./ssh/index.js";
import { taskTools } from "./task/index.js";
import { excelTools } from "./excel/index.js";
import { docxTools } from "./docx/index.js";
import { pdfTools } from "./pdf/index.js";
import { browserTools } from "./browser/index.js";
import { interactionTools } from "./interaction/index.js";
import { imageTools } from "./image/index.js";
import { botTools } from "./bot/index.js";
import { webTools } from "./web/index.js";
import { speechTools } from "./speech/index.js";
import { musicTools } from "./music/index.js";
import { createAgentGeneralTool, createAgentExplorerTool } from "./agent/index.js";

export * from "./base.js";
export { ToolRegistry } from "./registry.js";
export { fileTools } from "./file/index.js";
export { cliTools } from "./cli/index.js";
export { dbTools } from "./db/index.js";
export { sshTools } from "./ssh/index.js";
export { taskTools } from "./task/index.js";
export { excelTools } from "./excel/index.js";
export { docxTools } from "./docx/index.js";
export { pdfTools } from "./pdf/index.js";
export { browserTools } from "./browser/index.js";
export { interactionTools } from "./interaction/index.js";
export { imageTools } from "./image/index.js";
export { botTools } from "./bot/index.js";
export { webTools } from "./web/index.js";
export { speechTools } from "./speech/index.js";
export { musicTools } from "./music/index.js";
export { createAgentGeneralTool, createAgentExplorerTool } from "./agent/index.js";

export interface RegistryOptions {
  /**
   * task_update is a built-in tool and is ALWAYS registered (it cannot be
   * disabled — it's a core part of the agent UX, not an opt-in feature).
   * This flag is kept only for backward compatibility with callers; the
   * default is true and callers should not pass false.
   */
  tasks?: boolean;
  /** Register filesystem + shell tools (file ops, exec). Disable when the
   * session has no working directory so the agent can't touch the local disk.
   * When false, file/exec/excel tools are hard-stripped regardless of
   * `enabledTools` (they need the project sandbox to function). Default true. */
  filesystem?: boolean;
  /**
   * Which tool names to register. Defaults to the file operations only
   * (`DEFAULT_ENABLED_TOOLS`). exec / db_query / ssh_exec / sftp /
   * excel_script default OFF — opt in via settings/env to keep the prompt lean
   * and the blast radius small. `task_update` ignores this filter (it is always
   * registered). `agent_general`/`agent_explorer` also respect this filter when
   * their factory gate (`opts.subagent` + `opts.provider`) is open, so each can
   * be toggled independently.
   */
  enabledTools?: Set<string>;
  /**
   * Register interaction tools such as ask_user. Default true. Hosts that
   * cannot block on a user prompt (for example Telegram long polling) may
   * disable this so the model sees only the explicitly enabled capabilities.
   */
  interaction?: boolean;
  /**
   * Register the `agent_general` tool (spawn a focused, context-isolated agent
   * for a single task). Default false — it's an opt-in power-user tool that
   * costs extra LLM calls per use. When true, `provider` MUST also be supplied
   * (the agent tool captures it to spin up child agents). This is the master
   * gate for the factory; whether `agent_general` and `agent_explorer` are
   * actually registered is then filtered per-name via `enabledTools`, so each
   * can be toggled independently (hosts that want both always-on should include
   * both names in `enabledTools`).
   */
  subagent?: boolean;
  /**
   * The provider used to build the `subagent` tool's child agents. Required
   * when `subagent: true`; ignored otherwise. This is a chicken-and-egg
   * workaround: the tool needs the provider at execute time, but
   * `ToolContext` carries none, so we closure-capture it here.
   */
  provider?: Provider;
  /**
   * Max iterations cap for subagents spawned by the `subagent` tool. When
   * unset, a safe fallback is used. Inherited from the parent agent's
   * `maxIterations` when the host passes it through.
   */
  subagentMaxIterations?: number;
}

/**
 * Tools enabled by default: file operations. Everything else (exec,
 * db_query, ssh, excel) is opt-in so the prompt stays small and dangerous
 * tools are off until the user explicitly turns them on.
 */
export const DEFAULT_ENABLED_TOOLS = new Set<string>([
  "read_file",
  "write_file",
  "edit_file",
  "copy_file",
  "list_dir",
  "delete_file",
  "grep",
]);

export function createDefaultRegistry(opts: RegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const enabled = opts.enabledTools ?? DEFAULT_ENABLED_TOOLS;
  const hasFs = opts.filesystem !== false;

  // Local file/output tools require the project sandbox (workdir).
  // Register only those the user enabled AND only when a workdir exists.
  const fsCandidates = [...fileTools, ...cliTools, ...excelTools, ...docxTools, ...pdfTools, ...imageTools, ...musicTools];
  for (const tool of fsCandidates) {
    if (hasFs && enabled.has(tool.name)) registry.register(tool);
  }
  // db / ssh / browser / bot / web / speech tools don't need file helpers — register by user preference only.
  for (const tool of [...dbTools, ...sshTools, ...browserTools, ...botTools, ...webTools, ...speechTools]) {
    if (enabled.has(tool.name)) registry.register(tool);
  }
  // task_update is always registered — it's a built-in tool (default true,
  // callers should not pass false; the flag exists only for compat).
  if (opts.tasks !== false) {
    for (const tool of taskTools) registry.register(tool);
  }
  // Interaction tools (ask_user) are enabled by default for interactive hosts.
  if (opts.interaction !== false) {
    for (const tool of interactionTools) registry.register(tool);
  }
  // Subagent + Explore tools: opt-in power-user features. Registered LAST so
  // the factory closures capture the fully-built registry. The `opts.subagent`
  // flag is the master gate (kept for backward-compat with hosts that hardcode
  // it true); individual enable/disable is then controlled by `enabledTools`,
  // so each can be toggled independently (e.g. from the Telegram admin panel).
  if (opts.subagent && opts.provider) {
    const sub = createAgentGeneralTool(opts.provider, registry, opts.subagentMaxIterations);
    const exp = createAgentExplorerTool(opts.provider, registry, opts.subagentMaxIterations);
    if (enabled.has(sub.name)) registry.register(sub);
    if (enabled.has(exp.name)) registry.register(exp);
  }
  return registry;
}
