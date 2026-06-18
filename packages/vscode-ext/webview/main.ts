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

/**
 * Set when the user clicked "Edit" on the last turn: the DOM has already been
 * rewound (old user + assistant removed) and the old prompt is in the
 * composer. The Agent still holds the old turn until the user re-sends, so
 * on submit we must post `edit_last` (host rewinds the Agent THEN sends)
 * rather than `send` (which would just append, leaving the old turn behind).
 */
let editingLast = false;

marked.setOptions({ gfm: true, breaks: true });

const root = document.getElementById("root")!;

// ---------- Inline SVG icons ----------
const ICONS = {
  brand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 5.5c-1.4-1.6-3.4-2.5-5.9-2.5-3.7 0-6.1 1.9-6.1 4.8 0 2.7 2.2 3.9 5.5 4.6 3 .6 5 1.4 5 3.4 0 1.8-1.7 3.2-4.7 3.2-2.5 0-4.7-.9-6.3-2.6"/><path d="M5.2 5.4H3.3"/><path d="M20.7 18.6h-1.9"/><circle cx="2.6" cy="5.4" r="1.1" fill="currentColor" stroke="none"/><circle cx="21.4" cy="18.6" r="1.1" fill="currentColor" stroke="none"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  ai: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  newSession: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  loadSession: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
  usage: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
  tool: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
};

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
  bindScrollTracker();
  mountJumpButton();
}

function updateTopbar(): void {
  // Topbar is brand icon + menu only.
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
  const pct = state.tasks.length > 0 ? Math.round((done / state.tasks.length) * 100) : 0;

  const items = state.tasks
    .map((t) => {
      const cls =
        t.status === "completed"
          ? "done"
          : t.status === "in_progress"
            ? "inprogress"
            : "pending";
      const marker =
        t.status === "completed"
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
          : t.status === "in_progress"
            ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="5"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>`;
      return `<li class="${cls}"><span class="task-ico">${marker}</span><span class="task-text">${escape(t.content)}</span></li>`;
    })
    .join("");

  taskPanelEl.innerHTML = `
    <div class="task-panel-header" id="tp-header">
      <span class="task-panel-chevron">${chevron}</span>
      <span class="task-panel-title">tasks <b>${done}/${state.tasks.length}</b></span>
      <div class="task-panel-progress"><div class="task-panel-progress-fill" style="width:${pct}%"></div></div>
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
  pendingEl.innerHTML = `<span class="thinking-dots"><span></span><span></span><span></span></span>`;
  messagesEl.appendChild(pendingEl);
  scrollToBottom();
}

function hidePending(): void {
  if (!pendingEl) return;
  pendingEl.classList.add("leaving");
  const el = pendingEl;
  pendingEl = null;
  // Let the fade-out finish before removing from the DOM.
  setTimeout(() => el.remove(), 160);
}

function renderTopbar(): HTMLElement {
  const el = document.createElement("div");
  el.className = "topbar";

  const brand = document.createElement("div");
  brand.className = "topbar-brand";
  brand.innerHTML = `<span class="brand-icon">${ICONS.brand}</span>`;
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

  const items: Array<[string, Cmd, string] | "divider"> = [
    ["Settings", "settings", ICONS.settings],
    "divider",
    ["New session", "new", ICONS.newSession],
    ["Load session", "load", ICONS.loadSession],
    "divider",
    ["Usage", "usage", ICONS.usage],
    ["Clear all sessions", "clearAll", ICONS.trash],
  ];
  for (const item of items) {
    if (item === "divider") {
      const d = document.createElement("div");
      d.className = "divider";
      pop.appendChild(d);
      continue;
    }
    const [label, cmd, icon] = item;
    const btn = document.createElement("button");
    btn.innerHTML = `${icon}<span>${escape(label)}</span>`;
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
    <div class="modal-subtitle">Configure your provider and agent behavior.</div>
    ${mustConfigure ? `<div class="must-configure">An API key is required before you can chat. Fill in the form below.</div>` : ""}
    <div class="form-section">
      <div class="form-section-title">Provider</div>
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
    </div>
    <div class="form-section">
      <div class="form-section-title">Agent</div>
      <div class="form-row inline">
        <label for="cfg-tasks">Enable task checklist</label>
        <input type="checkbox" id="cfg-tasks">
      </div>
      <div class="form-row inline">
        <label for="cfg-autocontinue">Auto-continue cut-off responses</label>
        <input type="checkbox" id="cfg-autocontinue">
      </div>
      <div class="form-row inline">
        <label for="cfg-hidetools">Hide tool call details (spinner only)</label>
        <input type="checkbox" id="cfg-hidetools">
      </div>
      <div class="form-row">
        <label>Max iterations per turn</label>
        <input type="number" id="cfg-max" min="1" max="500">
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Context optimization</div>
      <div class="form-row inline">
        <label for="cfg-optimize">Context optimization (drop/summary)</label>
        <input type="checkbox" id="cfg-optimize">
      </div>
      <div class="form-row">
        <label>Context optimize mode</label>
        <select id="cfg-optmode">
          <option value="drop">drop</option>
          <option value="summary">summary</option>
        </select>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Developer</div>
      <div class="form-row inline">
        <label for="cfg-debug">Debug logging (stderr)</label>
        <input type="checkbox" id="cfg-debug">
      </div>
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
  (modal.querySelector("#cfg-optmode") as HTMLSelectElement).value = values.contextOptimizeMode;
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
    const contextOptimizeMode = (modal.querySelector("#cfg-optmode") as HTMLSelectElement).value as "drop" | "summary";
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
        contextOptimizeMode,
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
  // If we came from "Edit", the host must rewind the Agent's old turn before
  // re-sending — otherwise the stale turn stays in Agent history (and gets
  // persisted on the next save, then reappears on session reload). The DOM
  // was already rewound at click time; the host now does the same to state.
  const wasEditing = editingLast;
  editingLast = false;
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
  vscode.postMessage({ kind: wasEditing ? "edit_last" : "send", input: text });
}

function setBusy(b: boolean): void {
  state.busy = b;
  if (!b) state.stopping = false;
  updateComposerState();
  // Clear action buttons while generating; they're re-attached on assistant_end.
  if (b) document.querySelectorAll(".msg .actions").forEach((n) => n.remove());
}

function requestStop(): void {
  if (!state.busy || state.stopping) return;
  state.stopping = true;
  updateComposerState();
  const btn = document.getElementById("send-btn");
  if (btn) {
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 420);
  }
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
      btn.innerHTML = ICONS.send;
    }
  }
  if (ta) ta.disabled = state.busy;
  if (hint) {
    hint.innerHTML = state.busy
      ? state.stopping
        ? "Stopping generation..."
        : "Generating — click Stop to cancel"
      : `<kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline`;
  }
}

function appendUserMessage(text: string): void {
  const messages = document.getElementById("messages");
  if (!messages) return;
  syncEmptyState(false);
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="role"><span class="role-dot"></span>You</div><div class="body"></div>`;
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
  el.innerHTML = `<div class="role"><span class="role-dot"></span>Siberflow</div><div class="body">${marked.parse(text)}</div>`;
  messagesEl.appendChild(el);
  const body = el.querySelector(".body") as HTMLElement | null;
  if (body) enhanceCodeBlocks(body);
}

function startAssistant(): void {
  if (!messagesEl) return;
  syncEmptyState(false);
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="role"><span class="role-dot"></span>Siberflow</div><div class="body"><span class="thinking-dot"></span></div>`;
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
    enhanceCodeBlocks(currentTextEl);
  }
  currentTextEl = null;
  state.currentAssistantText = "";
}

/**
 * Add a "copy" overlay button to every <pre> code block inside `container`.
 * Uses the Clipboard API. Idempotent — skips <pre> that already have a
 * button. Called after markdown render (streaming finalize + history load).
 */
function enhanceCodeBlocks(container: HTMLElement): void {
  const pres = container.querySelectorAll("pre");
  for (const pre of pres) {
    if (pre.querySelector(":scope > .code-copy")) continue;
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.type = "button";
    btn.title = "Copy code";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      try {
        await navigator.clipboard.writeText(code);
        btn.classList.add("copied");
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        }, 1400);
      } catch {
        btn.textContent = "!";
      }
    });
    pre.appendChild(btn);
  }
}

function finalizeAssistant(): void {
  if (state.currentAssistant) {
    const body = state.currentAssistant.querySelector(".body") as HTMLElement;
    removeThinkingDot(body);
  }
  finalizeCurrentTextEl();
  state.currentAssistant = null;
}

/**
 * Strip any lingering action bar from all messages, then attach a fresh
 * "regenerate / edit" action bar under the LAST assistant message. Only one
 * bar is visible at a time (the most recent response). Hidden while busy.
 */
function refreshActionBar(): void {
  document.querySelectorAll(".msg .actions").forEach((n) => n.remove());
  if (state.busy) return;
  const assistants = messagesEl?.querySelectorAll(".msg.assistant");
  const last = assistants?.[assistants.length - 1] as HTMLElement | undefined;
  if (!last) return;

  const actions = document.createElement("div");
  actions.className = "actions";

  const regen = document.createElement("button");
  regen.className = "action-btn";
  regen.type = "button";
  regen.title = "Regenerate response";
  regen.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg><span>Regenerate</span>`;
  regen.addEventListener("click", () => {
    if (state.busy) return;
    if (!confirmRewind()) return;
    rewindLastAssistant();
    showPending();
    setBusy(true);
    vscode.postMessage({ kind: "regenerate" });
  });

  const edit = document.createElement("button");
  edit.className = "action-btn";
  edit.type = "button";
  edit.title = "Edit your last message";
  edit.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Edit</span>`;
  edit.addEventListener("click", () => {
    if (state.busy) return;
    const ta = document.getElementById("input") as HTMLTextAreaElement | null;
    if (!ta) return;
    const last = lastUserText();
    if (last === null) return;
    if (!confirmRewind()) return;
    // Edit REPLACES the last turn: rewind both the assistant response and
    // the old user message, then drop the old prompt into the composer so
    // the user can revise and re-send. Mark editingLast so the next submit
    // posts `edit_last` (host rewinds the Agent THEN sends) instead of
    // `send` (which would append and leave the old turn in Agent history).
    rewindLastAssistant();
    rewindLastUser();
    editingLast = true;
    ta.value = last;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    ta.focus();
    // Re-attach the bar to whatever assistant message is now last (or none).
    refreshActionBar();
    // Editing does not auto-send — user reviews and presses Enter / Send.
  });

  actions.appendChild(regen);
  actions.appendChild(edit);
  last.appendChild(actions);
}

/** Returns the text of the last user message in the DOM, or null. */
function lastUserText(): string | null {
  const users = messagesEl?.querySelectorAll(".msg.user");
  const last = users?.[users.length - 1] as HTMLElement | undefined;
  if (!last) return null;
  return last.querySelector(".body")?.textContent ?? null;
}

/** Confirm before rewinding since it discards the last response + tool work. */
function confirmRewind(): boolean {
  // No native confirm (webview restriction) — proceed directly; the rewind is
  // cheap and the original session on disk is untouched until the next turn.
  return true;
}

/** Remove the last assistant message (response + tool blocks) from the DOM. */
function rewindLastAssistant(): void {
  const assistants = messagesEl?.querySelectorAll(".msg.assistant");
  const last = assistants?.[assistants.length - 1] as HTMLElement | undefined;
  last?.remove();
}

/** Remove the last user message from the DOM (used by the edit flow). */
function rewindLastUser(): void {
  const users = messagesEl?.querySelectorAll(".msg.user");
  const last = users?.[users.length - 1] as HTMLElement | undefined;
  last?.remove();
}

function startToolCall(index: number, name: string): void {
  // task_update is a silent housekeeping tool: still executed, but never
  // rendered — its effect shows in the task panel instead.
  if (name === "task_update") {
    // Register a placeholder so showToolResult can no-op cleanly.
    state.currentTools.set(index, {
      root: document.createElement("div"),
      argsEl: null,
      resultEl: null,
      argsBuffer: "",
      name,
      completed: false,
    });
    return;
  }
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
    head.innerHTML = `<span class="tool-chevron">▾</span><span class="tool-icon">${ICONS.tool}</span><span class="tool-label">${escape(name)}</span>`;
    root.appendChild(head);
    // Wrap args + future result in a collapsible body so the header can
    // toggle them as a unit.
    const toolBody = document.createElement("div");
    toolBody.className = "tool-body";
    argsEl = document.createElement("div");
    argsEl.className = "args";
    toolBody.appendChild(argsEl);
    root.appendChild(toolBody);
    head.addEventListener("click", () => {
      const collapsed = root.classList.toggle("collapsed");
      head.querySelector(".tool-chevron")!.textContent = collapsed ? "▸" : "▾";
    });
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
  // task_update: never rendered; just mark complete and drop the placeholder.
  if (name === "task_update") {
    t.completed = true;
    return;
  }
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
  // Append into the collapsible tool body if present, else the root.
  const toolBody = t.root.querySelector(":scope > .tool-body");
  if (toolBody) toolBody.appendChild(r);
  else t.root.appendChild(r);
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

// Auto-scroll tracking: only stick to the bottom when the user is already
// near it. Once they scroll up to read history, streaming no longer yanks
// the view down. A "jump to bottom" button surfaces while pinned up.
let userPinnedUp = false;

function bindScrollTracker(): void {
  const el = document.getElementById("messages");
  if (!el) return;
  el.addEventListener("scroll", () => {
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userPinnedUp = !nearBottom;
    updateJumpButton();
  });
}

function updateJumpButton(): void {
  const btn = document.getElementById("jump-bottom");
  if (btn) btn.classList.toggle("visible", userPinnedUp);
}

function scrollToBottom(force = false): void {
  const messages = document.getElementById("messages");
  if (!messages) return;
  if (force || !userPinnedUp) {
    messages.scrollTop = messages.scrollHeight;
    userPinnedUp = false;
  }
}

function mountJumpButton(): void {
  if (document.getElementById("jump-bottom")) return;
  const btn = document.createElement("button");
  btn.id = "jump-bottom";
  btn.title = "Jump to latest";
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>`;
  btn.addEventListener("click", () => {
    scrollToBottom(true);
    updateJumpButton();
  });
  document.getElementById("root")?.appendChild(btn);
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
    <div class="empty-icon">${ICONS.brand}</div>
    <div class="empty-title">How can I help?</div>
    <div class="empty-copy">Ask for code edits, file inspection, shell commands, or database queries. Tools: file ops, <code>exec</code>, <code>db_query</code>.</div>
    <div class="empty-actions">
      <button class="empty-chip" data-prompt="Explain what this codebase does and its main entry points">Explain this codebase</button>
      <button class="empty-chip" data-prompt="Review the current file for bugs and suggest improvements">Review for bugs</button>
      <button class="empty-chip" data-prompt="Refactor the selected code for readability">Refactor my code</button>
    </div>
  `;
  // Wire up quick-action chips to fill the composer.
  el.querySelectorAll(".empty-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = (chip as HTMLElement).dataset.prompt ?? "";
      const ta = document.getElementById("input") as HTMLTextAreaElement | null;
      if (!ta) return;
      ta.value = prompt;
      ta.dispatchEvent(new Event("input"));
      ta.focus();
    });
  });
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
      ? `<span class="thinking-dots"><span></span><span></span><span></span></span><span>tools ${hiddenToolSummary.completed}/${total}</span>`
      : `<span class="tool-icon" style="color:var(--vscode-charts-green)">✓</span><span>tools ${total}</span>`;
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
      refreshActionBar();
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
      refreshActionBar();
      break;
  }
});

// Kick off the handshake
vscode.postMessage({ kind: "init" });
