import * as vscode from "vscode";
import {
  Agent,
  clearSessions,
  createDefaultRegistry,
  createProvider,
  deleteSession,
  findByNameOrId,
  listSessions,
  loadSession,
  newSessionId,
  saveOptimizedView,
  saveSession,
  saveSessionSync,
  SESSION_FORMAT_VERSION,
  optimizeContext,
  type Provider,
  type Session,
  type Task,
  type ToolRegistry,
} from "@siberflow/core";
import type {
  BannerInfo,
  ExtToView,
  HistoryMessage,
  ProviderName,
  SessionInfo,
  SettingsValues,
  ViewToExt,
} from "./protocol.js";
import type { Message } from "@siberflow/core";

const VERSION = "0.1.0";

const SYSTEM_PROMPT = `You are siberflow, a coding agent integrated into VSCode. \
You share the user's workspace and your job is to help them inspect, modify, run, and verify code accurately. \
You have tools for file management (read_file, write_file, edit_file, copy_file, list_dir), \
shell execution (exec), and database access (db_query). All file operations are sandboxed to the project directory. \
Treat the real workspace state as the source of truth. Never guess file contents, command outputs, database results, or the current state of the project. \
If the answer depends on project state, runtime state, system state, or database state, use the appropriate tool. \
If a previous turn likely used tools but the exact evidence is no longer present in context, re-check with tools instead of inferring or pretending. \
When the user asks for coding help, inspect the relevant code or files before concluding. \
When the user wants a change, prefer doing the work end-to-end: inspect, edit, run or verify when practical, then report the result. \
Do not overwrite or ignore existing user changes unless explicitly asked. Work with the current codebase as it exists. \
Keep responses concise, direct, and factual. State assumptions briefly when needed. \
When verification was not possible, say so plainly.`;

const TASKS_GUIDANCE = `\n\n# Task checklist — IMPORTANT, use it aggressively
You have a \`task_update\` tool that shows the user a live checklist. Rules:
- If a request needs 2 OR MORE distinct steps, your VERY FIRST action MUST be a \`task_update\` \
call laying out the entire plan (every item "pending", except set the first to "in_progress"). \
Do this before any other tool call.
- After EACH step finishes, immediately call \`task_update\` again with updated statuses: mark the \
just-finished item "completed" and set the next one to "in_progress". Keep EXACTLY ONE item \
"in_progress" at a time. Do not batch updates or wait until the end.
- Always send the COMPLETE list on every call (full replacement), not just the changed item.
- Only skip the checklist for a genuinely single-step request.
- The checklist is for execution work. For a simple explanation, quick inspection, or a single factual answer, skip it.`;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "siberflow.chatView";

  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly projectDir: string;

  private provider: Provider | null = null;
  private registry: ToolRegistry | null = null;
  private agent: Agent | null = null;
  private settings: SettingsValues;
  private apiKey: string | null = null;
  private current: Session | null = null;
  private optSavedBytes = 0;
  private readyForChat = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Siberflow needs an open workspace folder.");
    }
    this.projectDir = folder.uri.fsPath;
    this.settings = readSettings();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "dist")],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage(
      (msg: ViewToExt) => this.handleViewMessage(msg),
      undefined,
      this.disposables,
    );
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  reveal(): void {
    vscode.commands.executeCommand("siberflow.chatView.focus");
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  async runCommand(
    cmd: "new" | "load" | "delete" | "clearAll" | "usage" | "tools" | "settings",
  ): Promise<void> {
    if (cmd === "settings") {
      await this.openSettings(false);
      return;
    }
    if (!this.readyForChat) {
      this.post({ kind: "info", message: "Configure settings first." });
      return;
    }
    switch (cmd) {
      case "new":
        await this.cmdNew();
        break;
      case "load":
        await this.cmdLoad();
        break;
      case "delete":
        await this.cmdDelete();
        break;
      case "clearAll":
        await this.cmdClearAll();
        break;
      case "usage":
        this.cmdUsage();
        break;
      case "tools":
        this.cmdTools();
        break;
    }
  }

  // -------- message routing --------

  private async handleViewMessage(msg: ViewToExt): Promise<void> {
    switch (msg.kind) {
      case "init":
        await this.onInit();
        break;
      case "send":
        await this.runTurn(msg.input);
        break;
      case "command":
        await this.runCommand(msg.command);
        break;
      case "save_settings":
        await this.saveSettings(msg.values, msg.apiKey);
        break;
    }
  }

  // -------- init / settings --------

  private async onInit(): Promise<void> {
    this.settings = readSettings();
    this.apiKey = await this.loadApiKey(this.settings.provider);
    if (this.settings.debug) process.env.SIBERFLOW_DEBUG = "true";
    else delete process.env.SIBERFLOW_DEBUG;

    if (!this.apiKey) {
      await this.openSettings(true);
      return;
    }
    this.rebuildAgent();
    this.readyForChat = true;
    await this.pickSessionOnStart();
    this.postReady();
  }

  private async openSettings(mustConfigure: boolean): Promise<void> {
    this.settings = readSettings();
    this.apiKey = await this.loadApiKey(this.settings.provider);
    this.post({
      kind: "settings",
      values: this.settings,
      hasApiKey: !!this.apiKey,
      mustConfigure,
    });
  }

  private async saveSettings(
    values: SettingsValues,
    apiKey: string | null,
  ): Promise<void> {
    const prevSettings = this.settings;
    const cfg = vscode.workspace.getConfiguration("siberflow");
    const target = vscode.ConfigurationTarget.Global;
    await Promise.all([
      cfg.update("provider", values.provider, target),
      cfg.update("model", values.model, target),
      cfg.update("tasks", values.tasks, target),
      cfg.update("contextOptimize", values.contextOptimize, target),
      cfg.update("autoContinue", values.autoContinue, target),
      cfg.update("hideTools", values.hideTools, target),
      cfg.update("debug", values.debug, target),
      cfg.update("maxIterations", values.maxIterations, target),
    ]);

    if (apiKey !== null) {
      if (apiKey.length > 0) {
        await this.ctx.secrets.store(secretKeyFor(values.provider), apiKey);
        this.apiKey = apiKey;
      } else {
        await this.ctx.secrets.delete(secretKeyFor(values.provider));
        this.apiKey = null;
      }
    } else {
      this.apiKey = await this.loadApiKey(values.provider);
    }

    this.settings = values;
    if (values.debug) process.env.SIBERFLOW_DEBUG = "true";
    else delete process.env.SIBERFLOW_DEBUG;

    if (!this.apiKey) {
      this.readyForChat = false;
      this.provider = null;
      this.registry = null;
      this.agent = null;
      this.post({
        kind: "settings",
        values,
        hasApiKey: false,
        mustConfigure: true,
      });
      this.post({ kind: "error", message: `API key for ${values.provider} required.` });
      return;
    }

    if (this.current) {
      this.current.provider = values.provider;
      this.current.model =
        values.model.trim().length > 0
          ? values.model.trim()
          : createProvider(values.provider, { apiKey: this.apiKey }).defaultModel;
      this.current.updatedAt = new Date().toISOString();
      if (!values.tasks) {
        delete this.current.tasks;
      } else if (prevSettings.tasks && this.agent) {
        this.current.tasks = [...this.agent.getTasks()];
      }
      saveSessionSync(this.current);
    }

    this.rebuildAgent();
    if (!this.readyForChat) {
      this.readyForChat = true;
      await this.pickSessionOnStart();
    }
    this.postReady();
    this.post({ kind: "info", message: "Settings saved." });
  }

  private async loadApiKey(provider: ProviderName): Promise<string | null> {
    const v = await this.ctx.secrets.get(secretKeyFor(provider));
    return v ?? null;
  }

  private rebuildAgent(): void {
    if (!this.apiKey) return;
    this.provider = createProvider(this.settings.provider, {
      apiKey: this.apiKey,
    });
    this.registry = createDefaultRegistry({ tasks: this.settings.tasks });
    this.agent = this.buildAgent();
    if (this.current) {
      this.agent.loadHistory(this.current.messages);
      if (this.settings.tasks && this.current.tasks?.length) {
        this.agent.loadTasks(this.current.tasks);
      }
    }
  }

  private buildAgent(): Agent {
    if (!this.provider || !this.registry) throw new Error("provider not ready");
    const modelOverride = this.settings.model.trim();
    const model =
      modelOverride.length > 0 ? modelOverride : this.provider.defaultModel;
    return new Agent({
      provider: this.provider,
      registry: this.registry,
      model,
      systemPrompt: this.settings.tasks
        ? SYSTEM_PROMPT + TASKS_GUIDANCE
        : SYSTEM_PROMPT,
      projectDir: this.projectDir,
      contextOptimize: { enabled: this.settings.contextOptimize },
      tasksEnabled: this.settings.tasks,
      autoContinue: this.settings.autoContinue,
      maxIterations: this.settings.maxIterations,
    });
  }

  private postReady(): void {
    this.post({
      kind: "ready",
      banner: this.banner(),
      session: this.sessionInfo(),
      hideTools: this.settings.hideTools,
      tasksEnabled: this.settings.tasks,
    });
    if (this.current && this.current.messages.length > 0) {
      this.post({
        kind: "history",
        messages: filterHistory(this.current.messages),
      });
    }
    if (this.settings.tasks && this.agent) {
      this.post({ kind: "tasks", tasks: this.agent.getTasks() as Task[] });
    }
  }

  // -------- session picker on first open --------

  private async pickSessionOnStart(): Promise<void> {
    const summaries = await listSessions({ projectDir: this.projectDir });
    if (summaries.length === 0) {
      this.startNewSession(null);
      return;
    }
    const items = [
      { label: "$(plus) New session…", id: "__new__" } as vscode.QuickPickItem & { id: string },
      ...summaries.map((s) => ({
        label: s.name ?? `(unnamed) ${s.id.slice(0, 12)}`,
        description: `${s.messageCount} msgs · ${s.updatedAt}`,
        id: s.id,
      })),
    ];
    const choice = await vscode.window.showQuickPick(items, {
      title: "Siberflow — pick a session",
      placeHolder: "Resume an existing chat or start a new one",
    });
    if (!choice || choice.id === "__new__") {
      this.startNewSession(null);
      return;
    }
    const session = await loadSession(choice.id);
    if (!session || !this.agent) {
      this.startNewSession(null);
      return;
    }
    this.agent.loadHistory(session.messages);
    if (this.settings.tasks && session.tasks?.length) {
      this.agent.loadTasks(session.tasks);
    }
    this.current = session;
  }

  private startNewSession(name: string | null): void {
    if (!this.provider) return;
    this.agent = this.buildAgent();
    const now = new Date().toISOString();
    const model =
      this.settings.model.trim().length > 0
        ? this.settings.model.trim()
        : this.provider.defaultModel;
    this.current = {
      version: SESSION_FORMAT_VERSION,
      id: newSessionId(),
      name,
      projectDir: this.projectDir,
      provider: this.provider.name,
      model,
      createdAt: now,
      updatedAt: now,
      messages: [...this.agent.history()],
      usage: emptyUsage(),
    };
    saveSessionSync(this.current);
    if (this.settings.contextOptimize) {
      const { messages: optimized } = optimizeContext(this.current.messages, {
        enabled: true,
      });
      void saveOptimizedView(this.current, optimized);
    }
  }

  // -------- turn runner --------

  private async runTurn(input: string): Promise<void> {
    if (!this.agent) {
      this.post({ kind: "error", message: "Configure settings first." });
      this.post({ kind: "assistant_end" });
      return;
    }
    let latestUsage: { promptTokens: number; completionTokens: number } | undefined;
    let turnAddPrompt = 0;
    let turnAddCompletion = 0;

    try {
      await this.agent.send(input, {
        onAssistantStart: () => this.post({ kind: "assistant_start" }),
        onContent: (delta) => this.post({ kind: "assistant_content", delta }),
        onAssistantEnd: (_msg, meta) => {
          if (meta.usage) {
            latestUsage = meta.usage;
            turnAddPrompt += meta.usage.promptTokens;
            turnAddCompletion += meta.usage.completionTokens;
          }
          // Close the current iteration's assistant DOM element so the next
          // iteration creates a fresh one. Without this, tool calls from
          // later iterations would stack BELOW text from earlier iterations
          // in the same assistant div, flipping the natural order.
          this.post({ kind: "iteration_end" });
        },
        onToolCallStart: (index, name) =>
          this.post({ kind: "tool_call_start", index, name }),
        onToolCallArgs: (index, delta) =>
          this.post({ kind: "tool_call_args", index, delta }),
        onToolResult: (index, name, result) =>
          this.post({ kind: "tool_result", index, name, result }),
        onTasksUpdated: (tasks) => {
          this.post({ kind: "tasks", tasks: tasks as Task[] });
          if (this.current) {
            this.current.tasks = [...tasks];
            this.current.updatedAt = new Date().toISOString();
            try {
              saveSessionSync(this.current);
            } catch {}
          }
        },
        onContextOptimized: (stats) => {
          this.optSavedBytes += stats.bytesSaved;
          this.post({ kind: "context_optimized", bytesSaved: stats.bytesSaved });
        },
        onMaxIterations: (limit) => this.post({ kind: "max_iterations", limit }),
      });

      if (this.current && latestUsage) {
        this.current.usage.last = latestUsage;
        this.current.usage.total.promptTokens += turnAddPrompt;
        this.current.usage.total.completionTokens += turnAddCompletion;
      }
      await this.persistAfterTurn();
    } catch (err) {
      this.post({ kind: "error", message: (err as Error).message });
    } finally {
      this.post({ kind: "assistant_end" });
    }
  }

  private async persistAfterTurn(): Promise<void> {
    if (!this.current || !this.agent) return;
    const model =
      this.settings.model.trim().length > 0
        ? this.settings.model.trim()
        : this.provider?.defaultModel ?? this.current.model;
    const session: Session = {
      ...this.current,
      provider: this.provider?.name ?? this.current.provider,
      model,
      updatedAt: new Date().toISOString(),
      messages: [...this.agent.history()],
      ...(this.settings.tasks ? { tasks: [...this.agent.getTasks()] } : {}),
    };
    if (!this.settings.tasks) {
      delete session.tasks;
    }
    await saveSession(session);
    this.current = session;
    if (this.settings.contextOptimize) {
      const { messages: optimized } = optimizeContext(session.messages, {
        enabled: true,
      });
      await saveOptimizedView(session, optimized);
    }
    this.post({ kind: "session_changed", session: this.sessionInfo() });
  }

  // -------- slash commands --------

  private async cmdNew(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "New session name (optional)",
      placeHolder: "feature-x (or leave empty)",
    });
    if (name === undefined) return;
    this.startNewSession(name.trim().length > 0 ? name.trim() : null);
    this.post({ kind: "session_changed", session: this.sessionInfo() });
    if (this.settings.tasks) this.post({ kind: "tasks", tasks: [] });
  }

  private async cmdLoad(): Promise<void> {
    const summaries = await listSessions({ projectDir: this.projectDir });
    if (summaries.length === 0) {
      this.post({ kind: "info", message: "no sessions available" });
      return;
    }
    const choice = await vscode.window.showQuickPick(
      summaries.map((s) => ({
        label: s.name ?? `(unnamed) ${s.id.slice(0, 12)}`,
        description: `${s.messageCount} msgs · ${s.updatedAt}`,
        id: s.id,
      })),
      { title: "Load session" },
    );
    if (!choice || !this.agent) return;
    const session = await loadSession(choice.id);
    if (!session) return;
    this.agent = this.buildAgent();
    this.agent.loadHistory(session.messages);
    if (this.settings.tasks && session.tasks?.length) {
      this.agent.loadTasks(session.tasks);
    }
    this.current = session;
    this.post({ kind: "session_changed", session: this.sessionInfo() });
    this.post({ kind: "history", messages: filterHistory(session.messages) });
    this.post({ kind: "tasks", tasks: (session.tasks ?? []) as Task[] });
  }

  private async cmdDelete(): Promise<void> {
    const query = await vscode.window.showInputBox({
      title: "Delete session — enter name or id",
    });
    if (!query) return;
    const target = await findByNameOrId(query, this.projectDir);
    if (!target) {
      vscode.window.showWarningMessage(`No session matching "${query}"`);
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete session "${target.name ?? target.id}"?`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") return;
    await deleteSession(target.id);
    if (this.current?.id === target.id) {
      this.current = null;
      this.agent = this.buildAgent();
      this.post({ kind: "session_changed", session: null });
      if (this.settings.tasks) this.post({ kind: "tasks", tasks: [] });
    }
    this.post({ kind: "info", message: `Deleted session "${target.name ?? target.id}"` });
  }

  private async cmdClearAll(): Promise<void> {
    const summaries = await listSessions({ projectDir: this.projectDir });
    if (summaries.length === 0) {
      this.post({ kind: "info", message: "no sessions to clear" });
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete ALL ${summaries.length} session(s) for this project? This cannot be undone.`,
      { modal: true },
      "Delete all",
    );
    if (confirm !== "Delete all") return;
    const removed = await clearSessions({ projectDir: this.projectDir });
    this.current = null;
    this.agent = this.buildAgent();
    this.post({ kind: "session_changed", session: null });
    if (this.settings.tasks) this.post({ kind: "tasks", tasks: [] });
    this.post({ kind: "info", message: `Cleared ${removed} session(s)` });
  }

  private cmdUsage(): void {
    if (!this.current) {
      this.post({ kind: "info", message: "no active session" });
      return;
    }
    this.post({
      kind: "usage",
      usage: this.current.usage,
      optSaved: this.optSavedBytes,
    });
  }

  private cmdTools(): void {
    if (!this.registry) return;
    const lines = this.registry
      .list()
      .map((t) => `${t.name} — ${t.description}`)
      .join("\n");
    this.post({ kind: "info", message: lines });
  }

  // -------- helpers --------

  private banner(): BannerInfo {
    if (!this.provider) {
      return { version: VERSION, provider: "?", model: "?", projectDir: this.projectDir };
    }
    return {
      version: VERSION,
      provider: this.provider.name,
      model:
        this.settings.model.trim().length > 0
          ? this.settings.model.trim()
          : this.provider.defaultModel,
      projectDir: this.projectDir,
    };
  }

  private sessionInfo(): SessionInfo | null {
    if (!this.current) return null;
    return {
      id: this.current.id,
      name: this.current.name,
      messageCount: this.current.messages.length,
    };
  }

  private post(msg: ExtToView): void {
    void this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const webviewUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview.js"),
    );
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Siberflow</title>
  <style>${INLINE_CSS}</style>
</head>
<body>
  <div id="root"></div>
  <script src="${webviewUri.toString()}"></script>
</body>
</html>`;
  }
}

/**
 * Convert internal Message[] into a flat user/assistant transcript suitable
 * for rendering on the webview after a session is loaded. Drops system
 * messages, tool results, and intermediate assistant messages that only
 * carried tool_calls without text content.
 */
function filterHistory(messages: readonly Message[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (
      m.role === "assistant" &&
      typeof m.content === "string" &&
      m.content.length > 0
    ) {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

function readSettings(): SettingsValues {
  const cfg = vscode.workspace.getConfiguration("siberflow");
  return {
    provider: cfg.get<ProviderName>("provider", "deepseek"),
    model: cfg.get<string>("model", ""),
    tasks: cfg.get<boolean>("tasks", false),
    contextOptimize: cfg.get<boolean>("contextOptimize", false),
    autoContinue: cfg.get<boolean>("autoContinue", true),
    hideTools: cfg.get<boolean>("hideTools", false),
    debug: cfg.get<boolean>("debug", false),
    maxIterations: cfg.get<number>("maxIterations", 50),
  };
}

function secretKeyFor(provider: ProviderName): string {
  return `siberflow.apiKey.${provider}`;
}

function emptyUsage() {
  return {
    last: { promptTokens: 0, completionTokens: 0 },
    total: { promptTokens: 0, completionTokens: 0 },
  };
}

const INLINE_CSS = `
:root {
  color-scheme: light dark;
  --sf-border: color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
  --sf-border-strong: color-mix(in srgb, var(--vscode-panel-border) 92%, var(--vscode-foreground) 8%);
  --sf-muted: color-mix(in srgb, var(--vscode-descriptionForeground) 88%, var(--vscode-foreground) 12%);
  --sf-surface: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-sideBar-background) 16%);
  --sf-surface-alt: color-mix(in srgb, var(--vscode-editorWidget-background) 78%, var(--vscode-editor-background) 22%);
  --sf-surface-raised: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, var(--vscode-editor-background) 10%);
  --sf-user: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
  --sf-assistant: color-mix(in srgb, var(--vscode-editorWidget-background) 78%, var(--vscode-editor-background) 22%);
  --sf-glow: color-mix(in srgb, var(--vscode-focusBorder) 24%, transparent);
  --sf-shadow: 0 12px 32px rgba(0,0,0,0.16);
}
html, body { margin: 0 !important; padding: 0 !important; height: 100%; }
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.topbar {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--sf-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-sideBar-background) 4%);
}
.topbar-brand { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.brand-mark {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--vscode-textLink-foreground);
}
.brand-name {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sf-muted);
}
.topbar-btn {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid transparent;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
.topbar-btn:hover {
  background: color-mix(in srgb, var(--vscode-list-hoverBackground) 88%, transparent);
}
.topbar-menu {
  font-size: 14px;
  line-height: 1;
  justify-self: end;
  width: 26px;
  height: 26px;
  padding: 0;
}
.popover {
  position: absolute;
  background: color-mix(in srgb, var(--vscode-menu-background, var(--vscode-editor-background)) 92%, black 8%);
  border: 1px solid var(--sf-border-strong);
  border-radius: 8px;
  padding: 4px;
  min-width: 200px;
  box-shadow: 0 8px 20px rgba(0,0,0,0.18);
  z-index: 50;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
}
.popover-cmd button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  background: transparent;
  color: inherit;
  border: none;
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
}
.popover-cmd button:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
}
.popover-cmd .divider { height: 1px; background: var(--sf-border); margin: 4px 2px; }
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.empty-state {
  margin: auto 0;
  padding: 10px 12px;
  border: 1px dashed var(--sf-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--sf-surface) 88%, transparent);
}
.empty-title {
  font-size: 12px;
  line-height: 1.45;
  font-weight: 600;
  margin-bottom: 4px;
}
.empty-copy {
  color: var(--sf-muted);
  line-height: 1.45;
  font-size: 11px;
}
.empty-copy code {
  font-family: var(--vscode-editor-font-family);
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 90%, transparent);
  border: 1px solid var(--sf-border);
  border-radius: 4px;
  padding: 1px 4px;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 100%;
}
.msg .role {
  font-weight: 700;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sf-muted);
  padding: 0 2px;
}
.msg.assistant .role { color: color-mix(in srgb, var(--vscode-textLink-foreground) 68%, var(--sf-muted)); }
.msg.user .role { color: color-mix(in srgb, var(--vscode-button-background) 78%, var(--sf-muted)); }
.msg .body {
  word-wrap: break-word;
  overflow-wrap: anywhere;
  border: 1px solid var(--sf-border);
  border-radius: 8px;
  padding: 8px 10px;
  line-height: 1.5;
  box-shadow: none;
}
.msg.user { align-items: stretch; }
.msg.user .role, .msg.user .body { width: 100%; }
.msg.assistant .role, .msg.assistant .body { width: 100%; }
.msg.user .body {
  white-space: pre-wrap;
  background: color-mix(in srgb, var(--sf-user) 82%, var(--vscode-editor-background) 18%);
  border-color: color-mix(in srgb, var(--vscode-button-background) 30%, var(--sf-border-strong));
}
.msg.assistant .body {
  max-width: 100%;
  background: color-mix(in srgb, var(--sf-assistant) 92%, transparent);
}
.msg.assistant:not(:has(.seg)) .role { display: none; }
.msg.assistant:not(:has(.seg)) .body {
  border-style: dashed;
  padding: 6px 8px;
  background: color-mix(in srgb, var(--sf-surface-alt) 72%, transparent);
}
.msg .body .seg + .seg, .msg .body .seg + .tool, .msg .body .tool + .seg { margin-top: 6px; }
.msg .body p { margin: 4px 0; }
.msg .body .seg > p:first-child { margin-top: 0; }
.msg .body .seg > p:last-child { margin-bottom: 0; }
.msg .body ul, .msg .body ol { margin: 4px 0; padding-left: 18px; }
.msg .body li { margin: 1px 0; }
.msg .body li > p { margin: 0; }
.msg .body h1, .msg .body h2, .msg .body h3, .msg .body h4 {
  margin: 10px 0 4px;
  line-height: 1.3;
  font-weight: 700;
}
.msg .body h1 { font-size: 1.08em; }
.msg .body h2 { font-size: 1.02em; }
.msg .body h3, .msg .body h4 { font-size: 1em; }
.msg .body .seg > h1:first-child, .msg .body .seg > h2:first-child, .msg .body .seg > h3:first-child { margin-top: 0; }
.msg .body a { color: var(--vscode-textLink-foreground); text-decoration-thickness: 1px; }
.msg .body blockquote {
  margin: 6px 0;
  padding: 6px 8px;
  border-left: 2px solid var(--vscode-textLink-foreground);
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 88%, transparent);
  border-radius: 0 6px 6px 0;
}
.msg .body pre {
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 88%, black 12%);
  border: 1px solid var(--sf-border);
  padding: 8px 10px;
  margin: 6px 0;
  max-width: 100%;
  overflow-x: auto;
  border-radius: 6px;
  line-height: 1.45;
}
.msg .body code {
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 90%, transparent);
  border: 1px solid var(--sf-border);
  padding: 1px 4px;
  border-radius: 4px;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.92em;
}
.msg .body pre code { background: transparent; border: none; padding: 0; }
.msg .body hr { border: none; border-top: 1px solid var(--sf-border); margin: 8px 0; }
.msg .body .seg { white-space: pre-wrap; }
.msg .body .seg:has(> p), .msg .body .seg:has(> ul), .msg .body .seg:has(> ol),
.msg .body .seg:has(> h1), .msg .body .seg:has(> h2), .msg .body .seg:has(> h3),
.msg .body .seg:has(> pre), .msg .body .seg:has(> blockquote) { white-space: normal; }
.tool {
  font-size: 12px;
  padding: 7px 8px;
  margin: 6px 0;
  border: 1px solid var(--sf-border);
  background: color-mix(in srgb, var(--sf-surface-raised) 92%, transparent);
  border-radius: 6px;
}
.tool .head {
  color: var(--vscode-textLink-foreground);
  font-weight: 600;
  font-size: 10px;
  letter-spacing: 0.02em;
}
.tool .args, .tool .result {
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.9;
  margin-top: 6px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
  line-height: 1.4;
}
.tool .result {
  border-top: 1px solid var(--sf-border);
  padding-top: 6px;
}
.tool.hidden-mode {
  font-style: italic;
  color: var(--sf-muted);
  border-style: dashed;
}
.tool.hidden-summary .head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tool.hidden-summary .summary-meta {
  margin-top: 4px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--sf-muted);
  word-break: break-word;
}
.notice {
  padding: 7px 8px;
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  line-height: 1.4;
  border: 1px solid transparent;
}
.notice.info { background: color-mix(in srgb, var(--vscode-inputValidation-infoBackground) 90%, transparent); border-color: var(--vscode-inputValidation-infoBorder); }
.notice.error { background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 90%, transparent); border-color: var(--vscode-inputValidation-errorBorder); }
.notice.warn { background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground) 90%, transparent); border-color: var(--vscode-inputValidation-warningBorder); }
.task-panel {
  margin: 0 8px 8px;
  border: 1px solid var(--sf-border);
  background: color-mix(in srgb, var(--sf-surface-alt) 92%, transparent);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
  flex: 0 0 auto;
}
.task-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  cursor: pointer;
  user-select: none;
}
.task-panel-header:hover { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, transparent); }
.task-panel-title { display: flex; align-items: center; gap: 6px; color: var(--sf-muted); font-size: 10px; }
.task-panel-title b { color: var(--vscode-foreground); font-weight: 700; }
.task-panel-chevron { font-size: 9px; opacity: 0.65; width: 10px; display: inline-block; text-align: center; }
.task-panel-body {
  padding: 0 8px 8px;
  max-height: 180px;
  overflow-y: auto;
  border-top: 1px solid var(--sf-border);
  background: color-mix(in srgb, var(--sf-surface) 72%, transparent);
}
.task-panel-body ul { list-style: none; padding: 6px 0 0; margin: 0; }
.task-panel-body li { padding: 2px 0; display: flex; gap: 6px; align-items: baseline; }
.task-panel-body .done { color: var(--vscode-charts-green); }
.task-panel-body .inprogress { font-weight: 700; color: var(--vscode-charts-yellow); }
.task-panel-body .pending { opacity: 0.58; }
.task-panel.collapsed .task-panel-body { display: none; }
.composer {
  padding: 8px;
  border-top: 1px solid var(--sf-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 98%, transparent);
}
.composer-shell {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  padding: 4px 5px 4px 6px;
  border: 1px solid var(--sf-border-strong);
  border-radius: 8px;
  background: var(--vscode-input-background);
  box-shadow: none;
}
.composer-shell:focus-within {
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 1px var(--sf-glow);
}
.composer textarea {
  flex: 1;
  resize: none;
  min-height: 24px;
  max-height: 140px;
  background: transparent;
  color: var(--vscode-input-foreground);
  border: none;
  padding: 3px 4px;
  font-family: inherit;
  font-size: inherit;
  line-height: 1.4;
  outline: none;
}
.composer textarea::placeholder { color: var(--sf-muted); }
.composer button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 6px;
  width: 26px;
  height: 26px;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s ease, filter 0.15s ease;
}
.composer button:hover:not(:disabled) { filter: brightness(1.06); }
.composer button:disabled { opacity: 0.35; cursor: default; filter: none; }
.composer button svg { display: block; }
.composer-hint {
  padding: 4px 2px 0;
  font-size: 10px;
  color: var(--sf-muted);
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(6px);
}
.modal {
  background: var(--vscode-editor-background);
  border: 1px solid var(--sf-border-strong);
  border-radius: 10px;
  padding: 16px;
  width: min(520px, 92vw);
  max-height: 92vh;
  overflow-y: auto;
  box-shadow: 0 12px 28px rgba(0,0,0,0.2);
}
.modal h3 { margin: 0 0 12px; }
.modal .form-row { display: flex; flex-direction: column; gap: 5px; margin: 10px 0; }
.modal .form-row label { font-size: 12px; opacity: 0.82; }
.modal .form-row.inline { flex-direction: row; align-items: center; gap: 10px; }
.modal .form-row.inline label { flex: 1; opacity: 1; }
.modal input[type="text"], .modal input[type="password"], .modal input[type="number"], .modal select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--sf-border-strong);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.modal input[type="checkbox"] { accent-color: var(--vscode-button-background); }
.modal .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.modal .modal-actions button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.modal .modal-actions button.secondary {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--sf-border-strong);
}
.modal .help { font-size: 11px; opacity: 0.7; margin-top: 2px; }
.modal .must-configure {
  padding: 8px 10px;
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 12px;
}
.pending {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px dashed var(--sf-border-strong);
  border-radius: 6px;
  color: var(--sf-muted);
  background: color-mix(in srgb, var(--sf-surface-alt) 72%, transparent);
  align-self: flex-start;
  font-size: 11px;
}
.spin { display: inline-block; animation: sp-rotate 0.9s linear infinite; }
@keyframes sp-rotate { to { transform: rotate(360deg); } }
.thinking-dot::before { content: "◴"; display: inline-block; animation: sp-rotate 0.9s linear infinite; }
.msg .body .thinking-dot { display: inline-block; opacity: 0.6; }
`;
