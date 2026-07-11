/**
 * Centralized system prompt + behavioral guidance for siberflow.
 *
 * This is the single source of truth — the CLI and VSCode extension both
 * import from here so the agent's behavior cannot drift between interfaces.
 * The only piece that legitimately differs by interface is the first line of
 * the base system prompt (where the agent is running), which is why
 * buildSystemPrompt takes an `interface` argument.
 */

export type AgentInterface = "terminal" | "vscode" | "telegram";

/**
 * Build the tool-availability sentence for the base prompt — a flat list of
 * the registered tool NAMES only. Per-tool capabilities, modes, and
 * constraints live in each tool's `description` (sent as the JSON schema), so
 * repeating them here would only bloat the prompt and risk drifting from the
 * schema. The model sees the full descriptions via the tool list; this
 * clause just frames that tools exist and notes the cross-cutting sandbox
 * scope that no single tool description conveys on its own.
 */
function buildToolClause(enabledToolNames: string[]): string {
  const has = (name: string): boolean => enabledToolNames.includes(name);
  const any = (...names: string[]): boolean => names.some(has);

  const toolsClause = enabledToolNames.length > 0
    ? `You have tools available: ${enabledToolNames.join(", ")}.`
    : "You currently have no tools registered.";

  // Cross-cutting sandbox scope — only mention what's relevant to the active
  // set. Per-tool sandbox details live in each tool's description; this is the
  // one fact that spans multiple tools and isn't obvious from any single one.
  const hasLocalFs = any("read_file", "write_file", "edit_file", "copy_file", "list_dir", "delete_file", "grep", "exec") ||
    has("excel_script") || has("docx_script") || has("pdf_script") || has("music_generate");
  const hasRemoteSsh = any("ssh_exec", "sftp");
  const scopeParts: string[] = [];
  if (hasLocalFs) scopeParts.push("all local file operations are sandboxed to the project directory");
  if (hasRemoteSsh) scopeParts.push("ssh_exec and sftp run remotely with NO sandbox");
  const scopeClause = scopeParts.length > 0
    ? ` ${scopeParts.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("; ")}.`
    : "";

  return `${toolsClause}${scopeClause}`;
}

const BASE_PROMPT = (iface: AgentInterface, enabledToolNames: string[]): string => {
  const opener =
    iface === "vscode"
      ? "You are siberflow, a coding agent integrated into VSCode. \
You share the user's workspace and your job is to help them inspect, modify, run, and verify code accurately."
      : iface === "telegram"
        ? "You are siberflow, a productivity agent running inside a Telegram bot. \
Each Telegram chat or thread has its own workspace directory and session history."
        : "You are siberflow, a coding agent running in a terminal. \
You share the user's workspace and your job is to help them inspect, modify, run, and verify code accurately.";
  return `${opener} \
${buildToolClause(enabledToolNames)} \
Keep responses concise, direct, and factual. State assumptions briefly when needed. \
When verification was not possible, say so plainly.`;
};

/**
 * Task checklist guidance — appended when the task_update tool is registered.
 * (Unified richer version: previously the CLI and VSCode copies had drifted
 * apart; this is the merged form.)
 */
export const TASKS_GUIDANCE = `\n\n# Task checklist — use it aggressively
You have a \`task_update\` tool that shows the user a live checklist. For any request with 2+ distinct \
steps, your FIRST action is a \`task_update\` call laying out the full plan (first item "in_progress", \
rest "pending"). After each step, call it again: mark the completed item "completed" and the next \
"in_progress" (exactly one in_progress at a time). Always send the COMPLETE list (full replacement). \
Skip it for genuinely single-step requests (quick inspection, explanation, or factual answer).`;

/**
 * Summary-mode context optimization breadcrumb explanation — appended when
 * the optimize mode emits `[SUMMARY]` tool-signature tags on past user
 * messages. That covers both the "summary" mode (all past turns) and the
 * "recent" mode (all past turns except the most recent completed one).
 * Callers set `summaryMode = true` for either of those modes.
 */
export const SUMMARY_GUIDANCE = `\n\n# [SUMMARY] tags in user messages
A trailing \`[SUMMARY]\` block (e.g. \`[SUMMARY]\\nexec("df -h")\\nwrite_file("src/foo.ts")\`) marks what tools ran \
in a past turn — a compact signature (tool + short arg). The full args and results were removed to save context. \
These signatures show WHAT was touched but NOT the values (which may be stale). If you need actual content/results, \
re-run the tool. Never output [SUMMARY] tags yourself — they're read-only optimizer metadata.`;

/**
 * Intent-handling guidance — always appended. Keeps responses fast and
 * focused by avoiding long speculative analyses on short-but-ambiguous
 * requests, without slowing down concrete well-scoped requests.
 */
export const INTENT_GUIDANCE = `\n\n# Short but ambiguous requests
For a brief but ambiguous request (e.g. "optimize it", "fix the app"), don't guess and then make sweeping \
changes. State your interpretation in one line; if still ambiguous, ask ONE clarifying question. Proceed \
only once the intent is clear. For concrete, well-scoped requests, just do the work without preamble.`;

/**
 * Build the agent-delegation guidance — Telegram only, appended when
 * agent_explorer and/or agent_general is registered. Generated dynamically so
 * it ONLY mentions tools that are actually registered (avoids confusing the
 * model with a tool it doesn't have). Telegram runs on a tighter context
 * budget than desktop/CLI, so the model MUST offload research/exploration to
 * the Agent Explorer and multi-step work to the Agent General.
 */
function buildAgentGuidance(hasExplorer: boolean, hasGeneral: boolean): string {
  const lines: string[] = ["\n\n# DELEGATE to your agent helper(s) — this is mandatory"];
  lines.push("You MUST use the agent tool(s) below; do NOT do this kind of work yourself.");
  if (hasExplorer) {
    lines.push(
      "- Research or information lookup (web search, news, docs, \"how does X work\", \"find all Y\", reading any URL): " +
        "MUST call `agent_explorer`. NEVER call web_search or run_browser yourself for these — that is the agent's job. " +
        "Calling web_search/run_browser directly when agent_explorer is available is a mistake.",
    );
  }
  if (hasGeneral) {
    lines.push(
      "- Multi-step work that needs many tool calls: MUST delegate to `agent_general`.",
    );
  }
  return lines.join("\n");
}

export interface BuildPromptOptions {
  interface: AgentInterface;
  tasksEnabled?: boolean;
  summaryMode?: boolean;
  /**
   * Names of tools actually registered for this session. Drives the
   * tool-availability sentence in the base prompt so it only mentions tools
   * the model can actually call. Defaults to an empty list (no tools
   * mentioned) — callers should pass `registry.list().map(t => t.name)`.
   */
  enabledToolNames?: string[];
}

/**
 * Assemble the full system prompt for a turn, combining the base prompt with
 * whichever guidance blocks apply to the current configuration. INTENT_GUIDANCE
 * is always included (it governs response shape, not an optional feature).
 */
export function buildSystemPrompt(opts: BuildPromptOptions): string {
  const tools = opts.enabledToolNames ?? [];
  let prompt = BASE_PROMPT(opts.interface, tools);
  prompt += INTENT_GUIDANCE;
  if (opts.tasksEnabled) prompt += TASKS_GUIDANCE;
  if (opts.summaryMode) prompt += SUMMARY_GUIDANCE;
  // Telegram-only nudge: prefer the agent helpers for research/multi-step work
  // to keep the tighter Telegram context budget clean. Generated dynamically so
  // only the actually-registered agent tool(s) are mentioned.
  const hasExplorer = tools.includes("agent_explorer");
  const hasGeneral = tools.includes("agent_general");
  if (opts.interface === "telegram" && (hasExplorer || hasGeneral)) {
    prompt += buildAgentGuidance(hasExplorer, hasGeneral);
  }
  return prompt;
}
