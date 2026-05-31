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
}

interface ToolElements {
  root: HTMLElement;
  argsEl: HTMLElement | null;
  resultEl: HTMLElement | null;
  argsBuffer: string;
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
};

marked.setOptions({ gfm: true, breaks: true });

const root = document.getElementById("root")!;

// Element references so updates can target panels without wiping #messages.
let mounted = false;
let topbarSessionLabel: HTMLElement | null = null;
let messagesEl: HTMLElement | null = null;
let pendingEl: HTMLElement | null = null;
// Pinned task panel sits between messages and the composer. Collapsible.
let taskPanelEl: HTMLElement | null = null;
let taskPanelCollapsed = false;
// The text segment we are currently streaming into. Reset to null whenever
// a tool call interrupts so the next content stream gets its own segment.
let currentTextEl: HTMLElement | null = null;

function mount(): void {
  if (mounted) return;
  mounted = true;
  root.innerHTML = "";
  root.appendChild(renderTopbar());
  messagesEl = document.createElement("div");
  messagesEl.className = "messages";
  messagesEl.id = "messages";
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
  if (!topbarSessionLabel) return;
  topbarSessionLabel.textContent = sessionDisplay();
}

function sessionDisplay(): string {
  if (!state.session) return "(no session)";
  const name = state.session.name ?? "(unnamed)";
  return `${name} · ${state.session.messageCount} msgs`;
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

  const sessionBtn = document.createElement("button");
  sessionBtn.className = "topbar-btn topbar-session";
  sessionBtn.title = "Session & connection info";
  const labelSpan = document.createElement("b");
  labelSpan.textContent = sessionDisplay();
  topbarSessionLabel = labelSpan;
  sessionBtn.appendChild(labelSpan);
  const chev = document.createElement("span");
  chev.textContent = "▾";
  chev.style.opacity = "0.5";
  sessionBtn.appendChild(chev);
  sessionBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openInfoPopover(sessionBtn);
  });
  el.appendChild(sessionBtn);

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

function openInfoPopover(anchor: HTMLElement): void {
  closePopovers();
  if (!state.banner) return;
  const pop = document.createElement("div");
  pop.className = "popover popover-info";
  pop.dataset.kind = "info";
  const rows: Array<[string, string]> = [
    ["version", `v${state.banner.version}`],
    ["provider", `${state.banner.provider}/${state.banner.model}`],
    ["session", sessionDisplay()],
  ];
  pop.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span class="k">${escape(k)}</span><span>${escape(v)}</span></div>`)
    .join("");
  positionAndShow(pop, anchor, "left");
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
  (modal.querySelector("#cfg-provider") as HTMLSelectElement).value = values.provider;
  (modal.querySelector("#cfg-model") as HTMLInputElement).value = values.model;
  (modal.querySelector("#cfg-tasks") as HTMLInputElement).checked = values.tasks;
  (modal.querySelector("#cfg-optimize") as HTMLInputElement).checked = values.contextOptimize;
  (modal.querySelector("#cfg-autocontinue") as HTMLInputElement).checked = values.autoContinue;
  (modal.querySelector("#cfg-hidetools") as HTMLInputElement).checked = values.hideTools;
  (modal.querySelector("#cfg-debug") as HTMLInputElement).checked = values.debug;
  (modal.querySelector("#cfg-max") as HTMLInputElement).value = String(values.maxIterations);

  modal.querySelector("#cfg-cancel")?.addEventListener("click", closeIfAllowed);
  modal.querySelector("#cfg-save")?.addEventListener("click", () => {
    const provider = (modal.querySelector("#cfg-provider") as HTMLSelectElement).value as SettingsValues["provider"];
    const apiKeyRaw = (modal.querySelector("#cfg-apikey") as HTMLInputElement).value;
    const model = (modal.querySelector("#cfg-model") as HTMLInputElement).value;
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
      submit();
    }
  });
  const btn = document.createElement("button");
  btn.id = "send-btn";
  btn.title = "Send (Enter)";
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`;
  btn.onclick = submit;
  el.appendChild(ta);
  el.appendChild(btn);
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
  const btn = document.getElementById("send-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = b;
}

function appendUserMessage(text: string): void {
  const messages = document.getElementById("messages");
  if (!messages) return;
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
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="role">ai</div><div class="body">${marked.parse(text)}</div>`;
  messagesEl.appendChild(el);
}

function startAssistant(): void {
  if (!messagesEl) return;
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="role">ai</div><div class="body"><span class="thinking-dot"></span></div>`;
  messagesEl.appendChild(el);
  state.currentAssistant = el;
  state.currentAssistantText = "";
  state.currentTools.clear();
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
  root.className = state.hideTools ? "tool hidden-mode" : "tool";
  const head = document.createElement("div");
  head.className = "head";
  head.innerHTML = state.hideTools
    ? `<span class="spin">◴</span> ${escape(name)}…`
    : `↳ tool ${escape(name)}`;
  root.appendChild(head);

  let argsEl: HTMLElement | null = null;
  if (!state.hideTools) {
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
    const head = t.root.querySelector(".head") as HTMLElement;
    head.textContent = `✓ ${name}`;
    return;
  }
  const r = document.createElement("div");
  r.className = "result";
  const preview =
    result.length > 800
      ? result.slice(0, 800) + `\n…[+${result.length - 800} bytes]`
      : result;
  r.textContent = preview;
  t.root.appendChild(r);
  t.resultEl = r;
  scrollToBottom();
}

function showNotice(level: "info" | "error" | "warn", message: string): void {
  const messages = document.getElementById("messages");
  if (!messages) return;
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
      for (const m of msg.messages) {
        if (m.role === "user") appendUserMessage(m.content);
        else appendAssistantHistory(m.content);
      }
      scrollToBottom();
      break;
  }
});

// Kick off the handshake
vscode.postMessage({ kind: "init" });
