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
 * Build the tool-availability sentence for the base prompt, mentioning ONLY
 * the tool categories whose tools are actually registered. The base prompt
 * used to hardcode every tool name; that misled the model when a tool was
 * toggled off (the schema wouldn't include it, yet the prompt claimed it
 * existed). Now the prompt is derived from the registered tool set so the
 * prose and the schema can never drift.
 *
 * Returns the full "You have tools for ..." clause plus the sandbox note.
 */
function buildToolClause(enabledToolNames: string[]): string {
  const has = (name: string): boolean => enabledToolNames.includes(name);
  const any = (...names: string[]): boolean => names.some(has);

  const parts: string[] = [];

  if (any("read_file", "write_file", "edit_file", "copy_file", "list_dir")) {
    const fileTools = ["read_file", "write_file", "edit_file", "copy_file", "list_dir"].filter(has);
    parts.push(`file management (${fileTools.join(", ")})`);
  }
  if (has("exec")) parts.push("shell execution (exec)");
  if (has("db_query")) parts.push("database access (db_query)");
  if (any("ssh_exec", "sftp")) {
    const sshTools = ["ssh_exec", "sftp"].filter(has);
    parts.push(`remote SSH commands (${sshTools.join(", ")})`);
  }
  if (has("excel_script")) {
    parts.push(
      "Excel spreadsheet manipulation (excel_script — read/modify/create .xlsx workbooks via the full " +
        "exceljs API in a sandboxed JS function: cells, formulas, images, charts, merge cells, styling)",
    );
  }
  if (has("docx_script")) {
    parts.push(
      "Word document manipulation (docx_script — create/read .docx via the docx/mammoth libraries in a " +
        "sandboxed JS function: headings, paragraphs, tables, images, bullets, styling)",
    );
  }
  if (has("pdf_script")) {
    parts.push(
      "PDF document manipulation (pdf_script — create/read .pdf via the pdf-lib/pdfjs libraries in a " +
        "sandboxed JS function: pages, text, shapes, colors, text extraction)",
    );
  }
  if (has("run_browser")) {
    parts.push("headless browser automation (run_browser for navigating/scraping/interacting with pages via the user's installed Chrome/Edge using the Puppeteer API — supports AJAX/SPA content, form fill, login, screenshots; when searching the web, do not use Google Search, use Bing, DuckDuckGo, Brave Search, or another non-Google search engine instead)");
  }
  if (has("analyze_image")) {
    parts.push("image analysis (analyze_image for describing images, OCR, screenshots, charts/tables, and visual reasoning using the configured multimodal OpenAI-compatible provider)");
  }
  if (has("ask_user")) {
    parts.push("user interaction (ask_user to ask the user a question when you need confirmation, a choice, or free-form input)");
  }

  // task_update is intentionally NOT listed here: it's always present when
  // tasks are enabled, but its usage is explained in TASKS_GUIDANCE (appended
  // separately), not in the tool-availability sentence.

  const toolsClause = parts.length > 0
    ? `You have tools for ${parts.join(", ")}.`
    : "You currently have no tools registered.";

  // Sandbox-scope note — only mention what's relevant to the active set.
  const hasLocalFs = any("read_file", "write_file", "edit_file", "copy_file", "list_dir", "exec") ||
    has("excel_script") || has("docx_script") || has("pdf_script");
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
        ? "You are siberflow, a coding and productivity agent running inside a Telegram bot. \
Each Telegram chat or thread has its own workspace directory and session history."
        : "You are siberflow, a coding agent running in a terminal. \
You share the user's workspace and your job is to help them inspect, modify, run, and verify code accurately.";
  return `${opener} \
${buildToolClause(enabledToolNames)} \
Treat the real workspace state as the source of truth. Never guess file contents, command outputs, database results, or the current state of the project. \
If the answer depends on project state, runtime state, system state, or database state, use the appropriate tool. \
If a previous turn likely used tools but the exact evidence is no longer present in context, re-check with tools instead of inferring or pretending. \
When the user asks for coding help, inspect the relevant code or files before concluding. \
When the user wants a change, prefer doing the work end-to-end: inspect, edit, run or verify when practical, then report the result. \
Do not overwrite or ignore existing user changes unless explicitly asked. Work with the current codebase as it exists. \
Keep responses concise, direct, and factual. State assumptions briefly when needed. \
When verification was not possible, say so plainly.`;
};

/**
 * Task checklist guidance — appended when the task_update tool is registered.
 * (Unified richer version: previously the CLI and VSCode copies had drifted
 * apart; this is the merged form.)
 */
export const TASKS_GUIDANCE = `\n\n# Task checklist — IMPORTANT, use it aggressively
You have a \`task_update\` tool that shows the user a live checklist. Rules:
- If a request needs 2 OR MORE distinct steps, your VERY FIRST action MUST be a \`task_update\` \
call that lays out the entire plan up front (every item "pending", except set the first to "in_progress"). \
Do this before any other tool call.
- After EACH step finishes, immediately call \`task_update\` again with updated statuses: mark the \
just-finished item "completed" and set the next one to "in_progress". Keep EXACTLY ONE item \
"in_progress" at a time. Do not batch updates or wait until the end.
- Always send the COMPLETE list on every call (full replacement), not just the changed item.
- If you discover new sub-steps mid-task, add them to the list via task_update.
- Only skip the checklist for a genuinely single-step request (e.g. "read foo.ts", "what does X do?").
When in doubt, make a checklist — the user prefers seeing progress.
- The checklist is for execution work. For a simple explanation, quick inspection, or a single factual answer, skip it.`;

/**
 * Summary-mode context optimization breadcrumb explanation — appended when
 * the optimize mode emits `[SUMMARY]` tool-signature tags on past user
 * messages. That covers both the "summary" mode (all past turns) and the
 * "recent" mode (all past turns except the most recent completed one).
 * Callers set `summaryMode = true` for either of those modes.
 */
export const SUMMARY_GUIDANCE = `\n\n# [SUMMARY] tags in user messages
Some user messages carry a trailing \`[SUMMARY]\` block (e.g. \`[SUMMARY]\\nexec("df -h")\\nwrite_file("src/foo.ts")\`). \
This is a provenance marker injected by the context optimizer: it records WHICH tools ran in that past turn — as a \
compact signature of tool name plus short identifier args (path, command, query, line range). The full arguments \
and the tool results were removed to save context. \
Rules:
- A signature tells you WHAT was touched (e.g. "write_file touched src/foo.ts") but NOT what was written or what the \
tool returned. Those values may be stale, so do NOT treat them as fact.
- It tells you tool work happened in that turn, so the assistant's answer that followed was grounded in execution, not a guess.
- If you need the actual content/result of one of those past tool calls, re-run the tool — do not infer or fabricate it.
- Never output or mimic the [SUMMARY] format yourself; it is read-only metadata from the optimizer.`;

/**
 * Intent-handling guidance — always appended. Keeps responses fast and
 * focused by avoiding long speculative analyses on short-but-ambiguous
 * requests, without slowing down concrete well-scoped requests.
 */
export const INTENT_GUIDANCE = `\n\n# Short but ambiguous requests
When a request is brief but its goal or scope is unclear (e.g. "optimize it", "improve this", \
"make it better", "fix the app"), do NOT guess and then produce a large analysis or sweeping change. \
Instead: state your interpretation of the intent in one line; if it still seems ambiguous after that, \
ask ONE focused clarifying question. Only proceed with the work once the intent is clear, or clearly \
state the narrow interpretation you chose and proceed with that. This avoids wasted output on a wrong \
guess and keeps responses fast. For concrete, well-scoped requests, just do the work end-to-end without \
preamble.`;

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
  let prompt = BASE_PROMPT(opts.interface, opts.enabledToolNames ?? []);
  prompt += INTENT_GUIDANCE;
  if (opts.tasksEnabled) prompt += TASKS_GUIDANCE;
  if (opts.summaryMode) prompt += SUMMARY_GUIDANCE;
  return prompt;
}
