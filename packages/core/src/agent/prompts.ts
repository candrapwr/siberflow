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

  if (any("read_file", "write_file", "edit_file", "copy_file", "list_dir", "delete_file", "grep")) {
    const fileTools = ["read_file", "write_file", "edit_file", "copy_file", "list_dir", "delete_file", "grep"].filter(has);
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
      "PDF document manipulation (pdf_script — create/read .pdf via Python reportlab/pdfplumber: " +
        "pages, text, shapes, colors, full Unicode support, text extraction, OCR for scanned PDFs)",
    );
  }
  if (has("run_browser")) {
    parts.push("headless browser automation (run_browser via Puppeteer; when searching the web, use Bing/DuckDuckGo/Brave — NOT Google Search)");
  }
  if (has("analyze_image")) {
    parts.push("image analysis (analyze_image for describing images, OCR, screenshots, charts/tables, and visual reasoning using the configured multimodal OpenAI-compatible provider)");
  }
  if (has("music_generate")) {
    parts.push("music generation (music_generate for creating a 30-180 second audio track from a prompt and lyrics, saved inside the project directory; match duration to lyric length and keep short lyrics at 30 seconds)");
  }
  if (has("bot_script")) {
    parts.push("bot automation (bot_script for host-provided bot actions such as sending messages/photos/documents to the active bot chat; file manipulation is not included, use file tools when enabled)");
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
