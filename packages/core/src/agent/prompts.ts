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
 * Build the tool-availability sentence for the base prompt. The model already
 * receives the FULL tool list (names + descriptions) as JSON schemas in the
 * request's `tools` field, so repeating the names here would only bloat the
 * prompt and risk drifting from the schema. This clause just frames that tools
 * exist and notes the cross-cutting sandbox scope that no single tool
 * description conveys on its own.
 */
function buildToolClause(enabledToolNames: string[]): string {
  const has = (name: string): boolean => enabledToolNames.includes(name);
  const any = (...names: string[]): boolean => names.some(has);

  const toolsClause = enabledToolNames.length > 0
    ? "You have access to the tools provided for this session."
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
 * Trimmed to match the modular Nebula form: state what the tool is for and the
 * one invariant (one in_progress at a time), then defer to it. The host UI
 * already shows the live checklist, so heavy repetition isn't needed.
 */
export const TASKS_GUIDANCE = `\n\n# Task checklist
For multi-step work, use the \`task_update\` tool to show the plan and keep it updated. Send the complete \
current list when updating it, with at most one item marked in_progress. Skip it for single-step requests, \
explanations, and quick inspections.`;

/**
 * Tool-narration guidance — appended when any tools are registered. Tells the
 * model to emit a short natural-language line before each tool call so the
 * user can follow the work (Telegram streams intermediate assistant text as a
 * draft message; a one-line lead-in makes the transcript read like a
 * conversation instead of silent function calls).
 */
export const TOOL_NARRATION_GUIDANCE = `\n\n# Narrate around tool calls
Write one short sentence before each tool call describing what you'll do, in the user's language. Don't \
narrate after the result — just continue. For \`bot_script\`, skip the lead-in: the tool call itself carries \
the action. This keeps the conversation natural and lets the user follow your work.`;

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
  const lines: string[] = ["\n\n# Use your sub agent — this is mandatory"];
  lines.push("You MUST use the agent tool(s) below; do NOT do this kind of work yourself.");
  if (hasExplorer) {
    lines.push(
      "- Research or information lookup (web search, news, docs, \"how does X work\", \"find all Y\", reading any URL): " +
        "MUST call `agent_explorer`. NEVER call web_search or run_browser yourself for these — that is the agent's job. ",
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
 * Ordering mirrors the modular Nebula layout: behavioral guidance (intent,
 * narration, tasks) first, then optimizer metadata, then the optional
 * agent-delegation nudge. Telegram-specific runtime context + skills are
 * appended by the host afterwards.
 */
export function buildSystemPrompt(opts: BuildPromptOptions): string {
  const tools = opts.enabledToolNames ?? [];
  let prompt = BASE_PROMPT(opts.interface, tools);
  prompt += INTENT_GUIDANCE;
  // Tool-narration guidance only matters when tools are actually registered.
  if (tools.length > 0) prompt += TOOL_NARRATION_GUIDANCE;
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
