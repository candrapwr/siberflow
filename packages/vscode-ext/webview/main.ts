import { marked } from "marked";
import type {
  ExtToView,
  ViewToExt,
  BannerInfo,
  SessionInfo,
  SettingsValues,
} from "../src/protocol.js";
import type { SessionUsage, Task } from "@siberflow/core";

// VSCode webview API
declare const acquireVsCodeApi: () => {
  postMessage: (msg: ViewToExt) => void;
};
const vscode = acquireVsCodeApi();

interface UIState {
  banner: BannerInfo | null;
  session: SessionInfo | null;
  hideTools: boolean;
  tasksEnabled: boolean;
  tasks: Task[];
  /** Element of the currently streaming assistant message (or null). */
  currentAssistant: HTMLElement | null;
  currentAssistantText: string;
  /** Tool call elements by index for the current assistant turn. */
  currentTools: Map<number, ToolElements>;
  busy: boolean;
  stopping: boolean;
}

interface ToolElements {
  root: HTMLElement;
  argsEl: HTMLElement | null;
  resultEl: HTMLElement | null;
  argsBuffer: string;
  name?: string;
  completed?: boolean;
}

interface HiddenToolSummary {
  root: HTMLElement;
  headEl: HTMLElement;
  metaEl: HTMLElement;
  names: string[];
  completed: number;
}

const state: UIState = {
  banner: null,
  session: null,
  hideTools: false,
  tasksEnabled: false,
  tasks: [],
  currentAssistant: null,
  currentAssistantText: "",
  currentTools: new Map(),
  busy: false,
  stopping: false,
};

marked.setOptions({ gfm: true, breaks: true });

const root = document.getElementById("root")!;

// Element references so updates can target panels without wiping #messages.
let mounted = false;
let messagesEl: HTMLElement | null = null;
let pendingEl: HTMLElement | null = null;
let emptyStateEl: HTMLElement | null = null;
// Pinned task panel sits between messages and the composer. Collapsible.
let taskPanelEl: HTMLElement | null = null;
let taskPanelCollapsed = false;
// The text segment we are currently streaming into. Reset to null whenever
// a tool call interrupts so the next content stream gets its own segment.
let currentTextEl: HTMLElement | null = null;
let hiddenToolSummary: HiddenToolSummary | null = null;

function mount(): void {
  if (mounted) return;
  mounted = true;
  root.innerHTML = "";
  root.appendChild(renderTopbar());
  messagesEl = document.createElement("div");
  messagesEl.className = "messages";
  messagesEl.id = "messages";
  emptyStateEl = renderEmptyState();
  messagesEl.appendChild(emptyStateEl);
  root.appendChild(messagesEl);
  // Pinned panel above composer — hidden until tasks exist.
  taskPanelEl = document.createElement("div");
  taskPanelEl.className = "task-panel";
  taskPanelEl.style.display = "none";
  root.appendChild(taskPanelEl);
  root.appendChild(renderComposer());
  // Seed the panel if we already have tasks (resumed session).
  if (state.tasksEnabled && state.tasks.length > 0) updateTaskPanel();
}

function updateTopbar(): void {
  // Topbar is visual-only now: brand + menu.
}

/**
 * Render / update the pinned task panel between messages and composer.
 * Hidden entirely when there are no tasks. Header click toggles collapsed
 * state (body hidden, header still visible). Collapsed state persists
 * across updates within this webview lifetime.
 */
function updateTaskPanel(): void {
  if (!taskPanelEl) return;
  if (state.tasks.length === 0) {
    taskPanelEl.style.display = "none";
    return;
  }
  taskPanelEl.style.display = "";
  taskPanelEl.classList.toggle("collapsed", taskPanelCollapsed);

  const done = state.tasks.filter((t) => t.status === "completed").length;
  const chevron = taskPanelCollapsed ? "▸" : "▾";

  const items = state.tasks
    .map((t) => {
      const icon =
        t.status === "completed"
          ? "✔"
          : t.status === "in_progress"
            ? "▶"
            : "○";
      const cls =
        t.status === "completed"
          ? "done"
          : t.status === "in_progress"
            ? "inprogress"
            : "pending";
      return `<li><span class="${cls}">${icon}</span><span class="${cls}">${escape(t.content)}</span></li>`;
    })
    .join("");

  taskPanelEl.innerHTML = `
    <div class="task-panel-header" id="tp-header">
      <div class="task-panel-title">
        <span class="task-panel-chevron">${chevron}</span>
        <span>tasks <b>${done}/${state.tasks.length}</b></span>
      </div>
    </div>
    <div class="task-panel-body"><ul>${items}</ul></div>
  `;

  taskPanelEl.querySelector("#tp-header")?.addEventListener("click", () => {
    taskPanelCollapsed = !taskPanelCollapsed;
    updateTaskPanel();
  });
}

function showPending(): void {
  if (pendingEl || !messagesEl) return;
  pendingEl = document.createElement("div");
  pendingEl.className = "pending";
  pendingEl.innerHTML = `<span class="spin">◴</span><span>thinking…</span>`;
  messagesEl.appendChild(pendingEl);
  scrollToBottom();
}

function hidePending(): void {
  pendingEl?.remove();
  pendingEl = null;
}

function renderTopbar(): HTMLElement {
  const el = document.createElement("div");
  el.className = "topbar";

  const brand = document.createElement("div");
  brand.className = "topbar-brand";
  brand.innerHTML = `<span class="brand-mark"></span><span class="brand-name">Siberflow</span>`;
  el.appendChild(brand);

  const menuBtn = document.createElement("button");
  menuBtn.className = "topbar-btn topbar-menu";
  menuBtn.title = "Menu";
  menuBtn.textContent = "⋯";
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openCmdPopover(menuBtn);
  });
  el.appendChild(menuBtn);

  return el;
}

type Cmd = "new" | "load" | "usage" | "tools" | "delete" | "clearAll" | "settings";

function openCmdPopover(anchor: HTMLElement): void {
  closePopovers();
  const pop = document.createElement("div");
  pop.className = "popover popover-cmd";
  pop.dataset.kind = "cmd";

  const items: Array<[string, Cmd] | "divider"> = [
    ["⚙  Settings", "settings"],
    "divider",
    ["+  New session", "new"],
    ["↻  Load session", "load"],
    "divider",
    ["📊  Usage", "usage"],
    ["🗑  Clear all sessions", "clearAll"],
  ];
  for (const item of items) {
    if (item === "divider") {
      const d = document.createElement("div");
      d.className = "divider";
      pop.appendChild(d);
      continue;
    }
    const [label, cmd] = item;
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => {
      vscode.postMessage({ kind: "command", command: cmd });
      closePopovers();
    };
    pop.appendChild(btn);
  }
  positionAndShow(pop, anchor, "right");
}

function positionAndShow(pop: HTMLElement, anchor: HTMLElement, align: "left" | "right"): void {
  const rect = anchor.getBoundingClientRect();
  pop.style.position = "absolute";
  pop.style.top = `${rect.bottom + 4}px`;
  if (align === "right") {
    pop.style.right = `${window.innerWidth - rect.right}px`;
  } else {
    pop.style.left = `${rect.left}px`;
  }
  document.body.appendChild(pop);
  setTimeout(() => {
    document.addEventListener("click", closePopovers, { once: true });
  }, 0);
}

function closePopovers(): void {
  document.querySelectorAll(".popover").forEach((p) => p.remove());
}

function showSettingsModal(
  values: SettingsValues,
  hasApiKey: boolean,
  mustConfigure: boolean,
): void {
  // Remove existing modal if any
  document.querySelector(".modal-backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";

  const closeIfAllowed = () => {
    if (mustConfigure) return;
    backdrop.remove();
  };
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeIfAllowed();
  });

  modal.innerHTML = `
    <h3>Siberflow settings</h3>
    ${mustConfigure ? `<div class="must-configure">An API key is required before you can chat. Fill in the form below.</div>` : ""}
    <div class="form-row">
      <label>Provider</label>
      <select id="cfg-provider">
        <option value="deepseek">deepseek</option>
        <option value="gemini">gemini</option>
        <option value="openai">openai (chat completions)</option>
        <option value="openai-responses">openai-responses (/v1/responses)</option>
        <option value="grok">grok (xAI)</option>
        <option value="qwen">qwen (Alibaba)</option>
        <option value="zai">zai (GLM / Z.AI)</option>
        <option value="claude">claude (Anthropic)</option>
      </select>
    </div>
    <div class="form-row">
      <label>API key</label>
      <input type="password" id="cfg-apikey" placeholder="${hasApiKey ? "(stored — leave blank to keep)" : "paste your key"}" autocomplete="off">
      <div class="help">Stored encrypted in VSCode SecretStorage, per provider.</div>
    </div>
    <div class="form-row">
      <label>Model override</label>
      <input type="text" id="cfg-model" placeholder="(leave empty for provider default)">
    </div>
    <div class="form-row inline">
      <label for="cfg-tasks">Enable task checklist</label>
      <input type="checkbox" id="cfg-tasks">
    </div>
    <div class="form-row inline">
      <label for="cfg-optimize">Context optimization (drop old tool history)</label>
      <input type="checkbox" id="cfg-optimize">
    </div>
    <div class="form-row inline">
      <label for="cfg-autocontinue">Auto-continue cut-off responses</label>
      <input type="checkbox" id="cfg-autocontinue">
    </div>
    <div class="form-row inline">
      <label for="cfg-hidetools">Hide tool call details (spinner only)</label>
      <input type="checkbox" id="cfg-hidetools">
    </div>
    <div class="form-row inline">
      <label for="cfg-debug">Debug logging (stderr)</label>
      <input type="checkbox" id="cfg-debug">
    </div>
    <div class="form-row">
      <label>Max iterations per turn</label>
      <input type="number" id="cfg-max" min="1" max="500">
    </div>
    <div class="modal-actions">
      ${mustConfigure ? "" : '<button class="secondary" id="cfg-cancel">Cancel</button>'}
      <button id="cfg-save">Save</button>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  // Populate
  const providerSelect = modal.querySelector("#cfg-provider") as HTMLSelectElement;
  const modelInput = modal.querySelector("#cfg-model") as HTMLInputElement;
  providerSelect.value = values.provider;
  modelInput.value = values.model;
  (modal.querySelector("#cfg-tasks") as HTMLInputElement).checked = values.tasks;
  (modal.querySelector("#cfg-optimize") as HTMLInputElement).checked = values.contextOptimize;
  (modal.querySelector("#cfg-autocontinue") as HTMLInputElement).checked = values.autoContinue;
  (modal.querySelector("#cfg-hidetools") as HTMLInputElement).checked = values.hideTools;
  (modal.querySelector("#cfg-debug") as HTMLInputElement).checked = values.debug;
  (modal.querySelector("#cfg-max") as HTMLInputElement).value = String(values.maxIterations);

  providerSelect.addEventListener("change", () => {
    modelInput.value = "";
  });

  modal.querySelector("#cfg-cancel")?.addEventListener("click", closeIfAllowed);
  modal.querySelector("#cfg-save")?.addEventListener("click", () => {
    const provider = providerSelect.value as SettingsValues["provider"];
    const apiKeyRaw = (modal.querySelector("#cfg-apikey") as HTMLInputElement).value;
    const model = modelInput.value;
    const tasks = (modal.querySelector("#cfg-tasks") as HTMLInputElement).checked;
    const contextOptimize = (modal.querySelector("#cfg-optimize") as HTMLInputElement).checked;
    const autoContinue = (modal.querySelector("#cfg-autocontinue") as HTMLInputElement).checked;
    const hideTools = (modal.querySelector("#cfg-hidetools") as HTMLInputElement).checked;
    const debug = (modal.querySelector("#cfg-debug") as HTMLInputElement).checked;
    const maxIterations = Math.max(
      1,
      parseInt((modal.querySelector("#cfg-max") as HTMLInputElement).value, 10) || 50,
    );

    // null = leave existing key unchanged. "" = explicit clear. Non-empty = update.
    const apiKey: string | null = apiKeyRaw.length === 0 ? null : apiKeyRaw;

    vscode.postMessage({
      kind: "save_settings",
      values: {
        provider,
        model,
        tasks,
        contextOptimize,
        autoContinue,
        hideTools,
        debug,
        maxIterations,
      },
      apiKey,
    });
    backdrop.remove();
  });

  (modal.querySelector("#cfg-apikey") as HTMLInputElement).focus();
}


function renderComposer(): HTMLElement {
  const el = document.createElement("div");
  el.className = "composer";
  const shell = document.createElement("div");
  shell.className = "composer-shell";
  const ta = document.createElement("textarea");
  ta.placeholder = "Message…";
  ta.title = "Enter to send · Shift+Enter for newline";
  ta.id = "input";
  ta.rows = 1;
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.busy) submit();
    }
  });
  const btn = document.createElement("button");
  btn.id = "send-btn";
  btn.onclick = () => {
    if (state.busy) requestStop();
    else submit();
  };
  shell.appendChild(ta);
  shell.appendChild(btn);
  el.appendChild(shell);
  const hint = document.createElement("div");
  hint.className = "composer-hint";
  hint.id = "composer-hint";
  el.appendChild(hint);
  updateComposerState();
  return el;
}

function submit(): void {
  if (state.busy) return;
  const ta = document.getElementById("input") as HTMLTextAreaElement | null;
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  ta.value = "";
  ta.style.height = "auto";
  appendUserMessage(text);
  // Reset the task panel for the new turn. The previous turn's checklist
  // is stale; the model will repopulate via task_update if it decides to
  // maintain one this turn.
  if (state.tasks.length > 0) {
    state.tasks = [];
    updateTaskPanel();
  }
  showPending();
  setBusy(true);
  vscode.postMessage({ kind: "send", input: text });
}

function setBusy(b: boolean): void {
  state.busy = b;
  if (!b) state.stopping = false;
  updateComposerState();
}

function requestStop(): void {
  if (!state.busy || state.stopping) return;
  state.stopping = true;
  updateComposerState();
  vscode.postMessage({ kind: "stop" });
}

function updateComposerState(): void {
  const btn = document.getElementById("send-btn") as HTMLButtonElement | null;
  const ta = document.getElementById("input") as HTMLTextAreaElement | null;
  const hint = document.getElementById("composer-hint") as HTMLDivElement | null;
  if (btn) {
    btn.disabled = false;
    btn.classList.toggle("stop", state.busy);
    if (state.busy) {
      btn.title = state.stopping ? "Stopping..." : "Stop generation";
      btn.textContent = state.stopping ? "..." : "Stop";
    } else {
      btn.title = "Send (Enter)";
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`;
    }
  }
  if (ta) ta.disabled = state.busy;
  if (hint) {
    hint.textContent = state.busy
      ? state.stopping
        ? "Stopping generation..."
        : "Generating... click Stop to cancel"
      : "Enter to send  •  Shift+Enter for newline";
  }
}

function appendUserMessage(text: string): void {
  const messages = document.getElementById("messages");
  if (!messages) return;
  syncEmptyState(false);
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="role">you</div><div class="body"></div>`;
  el.querySelector(".body")!.textContent = text;
  messages.appendChild(el);
  scrollToBottom();
}

/** Render a completed assistant message from session history (already final, no streaming). */
function appendAssistantHistory(text: string): void {
  if (!messagesEl) return;
  syncEmptyState(false);
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="role">ai</div><div class="body">${marked.parse(text)}</div>`;
  messagesEl.appendChild(el);
}

function startAssistant(): void {
  if (!messagesEl) return;
  syncEmptyState(false);
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="role">ai</div><div class="body"><span class="thinking-dot"></span></div>`;
  messagesEl.appendChild(el);
  state.currentAssistant = el;
  state.currentAssistantText = "";
  state.currentTools.clear();
  hiddenToolSummary = null;
  currentTextEl = null;
  scrollToBottom();
}

function removeThinkingDot(body: HTMLElement): void {
  body.querySelector(".thinking-dot")?.remove();
}

function appendAssistantContent(delta: string): void {
  hidePending();
  if (!state.currentAssistant) startAssistant();
  state.currentAssistantText += delta;
  const body = state.currentAssistant!.querySelector(".body") as HTMLElement;
  removeThinkingDot(body);
  // Create a new text segment if there's no active one (i.e., we just
  // came out of a tool call, or this is the first content).
  if (!currentTextEl) {
    currentTextEl = document.createElement("div");
    currentTextEl.className = "seg";
    body.appendChild(currentTextEl);
  }
  // Stream as plain text for responsiveness — markdown render at segment end.
  currentTextEl.textContent = state.currentAssistantText;
  scrollToBottom();
}

function finalizeCurrentTextEl(): void {
  if (currentTextEl && state.currentAssistantText.length > 0) {
    currentTextEl.innerHTML = marked.parse(state.currentAssistantText) as string;
  }
  currentTextEl = null;
  state.currentAssistantText = "";
}

function finalizeAssistant(): void {
  if (state.currentAssistant) {
    const body = state.currentAssistant.querySelector(".body") as HTMLElement;
    removeThinkingDot(body);
  }
  finalizeCurrentTextEl();
  state.currentAssistant = null;
}

function startToolCall(index: number, name: string): void {
  hidePending();
  if (!state.currentAssistant) startAssistant();
  const body = state.currentAssistant!.querySelector(".body") as HTMLElement;
  removeThinkingDot(body);

  // Lock in any in-progress text segment as final markdown so the tool
  // block appears AFTER it (and the text stays put when the next iteration
  // streams more text).
  finalizeCurrentTextEl();

  const root = document.createElement("div");
  root.className = state.hideTools ? "tool hidden-mode hidden-summary" : "tool";
  const head = document.createElement("div");
  head.className = "head";

  let argsEl: HTMLElement | null = null;
  if (state.hideTools) {
    const summary = ensureHiddenToolSummary(body);
    summary.names.push(name);
    renderHiddenToolSummary();
    state.currentTools.set(index, {
      root: summary.root,
      argsEl: null,
      resultEl: null,
      argsBuffer: "",
      name,
      completed: false,
    });
    scrollToBottom();
    return;
  } else {
    head.innerHTML = `↳ tool ${escape(name)}`;
    root.appendChild(head);
    argsEl = document.createElement("div");
    argsEl.className = "args";
    root.appendChild(argsEl);
  }

  // Append inside body so it interleaves naturally with .seg text segments.
  body.appendChild(root);
  state.currentTools.set(index, {
    root,
    argsEl,
    resultEl: null,
    argsBuffer: "",
    name,
    completed: false,
  });
  scrollToBottom();
}

function appendToolArgs(index: number, delta: string): void {
  const t = state.currentTools.get(index);
  if (!t) return;
  t.argsBuffer += delta;
  if (t.argsEl) t.argsEl.textContent = t.argsBuffer;
}

function showToolResult(index: number, name: string, result: string): void {
  const t = state.currentTools.get(index);
  if (!t) return;
  if (state.hideTools) {
    if (!t.completed) {
      t.completed = true;
      if (hiddenToolSummary) {
        hiddenToolSummary.completed += 1;
        renderHiddenToolSummary();
      }
    }
    return;
  }
  const r = document.createElement("div");
  r.className = "result";
  const preview = formatToolResultPreview(name, t.argsBuffer, result);
  r.textContent = preview;
  t.root.appendChild(r);
  t.resultEl = r;
  scrollToBottom();
}

function showNotice(level: "info" | "error" | "warn", message: string): void {
  const messages = document.getElementById("messages");
  if (!messages) return;
  syncEmptyState(false);
  const el = document.createElement("div");
  el.className = `notice ${level}`;
  el.textContent = message;
  messages.appendChild(el);
  scrollToBottom();
}

function showUsage(usage: SessionUsage, optSaved: number): void {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const lines = [
    `last call: ${fmt(usage.last.promptTokens)} prompt + ${fmt(usage.last.completionTokens)} completion (current context)`,
    `session total: ${fmt(usage.total.promptTokens)} prompt + ${fmt(usage.total.completionTokens)} completion (billed)`,
  ];
  if (optSaved > 0) lines.push(`optimization: saved ${(optSaved / 1024).toFixed(1)} KB this run`);
  showNotice("info", lines.join("\n"));
}

function scrollToBottom(): void {
  const messages = document.getElementById("messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}

function renderEmptyState(): HTMLElement {
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `
    <div class="empty-title">Ask for code edits, file inspection, shell commands, or database queries.</div>
    <div class="empty-copy">Tools: file ops, <code>exec</code>, and <code>db_query</code>.</div>
  `;
  return el;
}

function syncEmptyState(forceVisible?: boolean): void {
  if (!messagesEl || !emptyStateEl) return;
  if (forceVisible === true) {
    if (!messagesEl.contains(emptyStateEl)) messagesEl.prepend(emptyStateEl);
    emptyStateEl.style.display = "";
    return;
  }

  const hasContent = !!messagesEl.querySelector(".msg, .notice, .pending");
  if (hasContent) {
    emptyStateEl.style.display = "none";
  } else {
    if (!messagesEl.contains(emptyStateEl)) messagesEl.prepend(emptyStateEl);
    emptyStateEl.style.display = "";
  }
}

function ensureHiddenToolSummary(body: HTMLElement): HiddenToolSummary {
  if (hiddenToolSummary) return hiddenToolSummary;

  const root = document.createElement("div");
  root.className = "tool hidden-mode hidden-summary";
  const headEl = document.createElement("div");
  headEl.className = "head";
  const metaEl = document.createElement("div");
  metaEl.className = "summary-meta";
  root.appendChild(headEl);
  root.appendChild(metaEl);
  body.appendChild(root);

  hiddenToolSummary = {
    root,
    headEl,
    metaEl,
    names: [],
    completed: 0,
  };
  return hiddenToolSummary;
}

function renderHiddenToolSummary(): void {
  if (!hiddenToolSummary) return;
  const total = hiddenToolSummary.names.length;
  const remaining = total - hiddenToolSummary.completed;
  const recent = summarizeToolNames(hiddenToolSummary.names);

  hiddenToolSummary.headEl.innerHTML =
    remaining > 0
      ? `<span class="spin">◴</span> tools ${hiddenToolSummary.completed}/${total}`
      : `✓ tools ${total}`;
  hiddenToolSummary.metaEl.textContent =
    total === 0
      ? ""
      : remaining > 0
        ? `${recent} • running ${remaining} more step${remaining > 1 ? "s" : ""}`
        : recent;
}

function summarizeToolNames(names: string[]): string {
  const unique = names.filter((name, idx) => names.indexOf(name) === idx);
  if (unique.length <= 3) return unique.join(" • ");
  return `${unique.slice(0, 3).join(" • ")} • +${unique.length - 3}`;
}

function formatToolResultPreview(name: string, rawArgs: string, result: string): string {
  if (name === "read_file") {
    const path = extractPathFromToolArgs(rawArgs);
    return path ? `read ${path}` : "read file";
  }

  return result.length > 800
    ? result.slice(0, 800) + `\n…[+${result.length - 800} bytes]`
    : result;
}

function extractPathFromToolArgs(rawArgs: string): string | null {
  try {
    const parsed = JSON.parse(rawArgs) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : null;
  } catch {
    return null;
  }
}

// ----- message dispatch from extension -----

window.addEventListener("message", (ev) => {
  const msg = ev.data as ExtToView;
  switch (msg.kind) {
    case "ready":
      state.banner = msg.banner;
      state.session = msg.session;
      state.hideTools = msg.hideTools;
      state.tasksEnabled = msg.tasksEnabled;
      if (mounted) {
        updateTopbar();
        updateTaskPanel();
      } else {
        mount();
      }
      break;
    case "assistant_start":
      // Show pending indicator between iterations (each iteration starts
      // with a brief wait for the model's first token).
      showPending();
      break;
    case "assistant_content":
      appendAssistantContent(msg.delta);
      break;
    case "iteration_end":
      // Close this iteration's assistant element so the next iteration
      // creates a fresh one — keeps tool/text order chronological.
      finalizeAssistant();
      break;
    case "assistant_end":
      hidePending();
      finalizeAssistant();
      setBusy(false);
      break;
    case "tool_call_start":
      startToolCall(msg.index, msg.name);
      break;
    case "tool_call_args":
      appendToolArgs(msg.index, msg.delta);
      break;
    case "tool_result":
      showToolResult(msg.index, msg.name, msg.result);
      break;
    case "tasks":
      state.tasks = msg.tasks;
      updateTaskPanel();
      break;
    case "context_optimized":
      break;
    case "max_iterations":
      showNotice(
        "warn",
        `reached the ${msg.limit}-iteration limit. Type "lanjutkan" to continue (or raise max iterations in settings).`,
      );
      break;
    case "session_changed": {
      const prevId = state.session?.id ?? null;
      const nextId = msg.session?.id ?? null;
      state.session = msg.session;
      updateTopbar();
      if (prevId !== nextId) {
        // Switched to a different session (or wiped) — clear the visible chat.
        if (messagesEl) messagesEl.innerHTML = "";
        if (messagesEl && emptyStateEl) {
          messagesEl.appendChild(emptyStateEl);
          syncEmptyState(true);
        }
        pendingEl = null;
        state.currentAssistant = null;
        state.currentAssistantText = "";
        state.currentTools.clear();
      }
      break;
    }
    case "usage":
      showUsage(msg.usage, msg.optSaved);
      break;
    case "info":
      showNotice("info", msg.message);
      break;
    case "error":
      hidePending();
      showNotice("error", msg.message);
      state.stopping = false;
      setBusy(false);
      break;
    case "settings":
      // Ensure the chat scaffold is mounted before the modal appears.
      if (!mounted) {
        if (!state.banner) {
          state.banner = { version: "0.1.0", provider: "?", model: "?", projectDir: "" };
        }
        mount();
      }
      showSettingsModal(msg.values, msg.hasApiKey, msg.mustConfigure);
      break;
    case "history":
      if (messagesEl) messagesEl.innerHTML = "";
      if (messagesEl && emptyStateEl) {
        messagesEl.appendChild(emptyStateEl);
        syncEmptyState(true);
      }
      pendingEl = null;
      state.currentAssistant = null;
      state.currentAssistantText = "";
      state.currentTools.clear();
      hiddenToolSummary = null;
      for (const m of msg.messages) {
        if (m.role === "user") appendUserMessage(m.content);
        else appendAssistantHistory(m.content);
      }
      syncEmptyState();
      scrollToBottom();
      break;
  }
});

// Kick off the handshake
vscode.postMessage({ kind: "init" });
