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

const SYSTEM_PROMPT = `You are siberflow, an AI assistant integrated into VSCode. \
You have tools for file management (read_file, write_file, edit_file, copy_file, list_dir) \
and shell execution (exec). All file operations are sandboxed to the project directory. \
Use tools when the user asks you to read, modify, or inspect their files or system. \
Keep responses concise.`;

const TASKS_GUIDANCE = `\n\n# Task checklist — IMPORTANT, use it aggressively
You have a \`task_update\` tool that shows the user a live checklist. Rules:
- If a request needs 2 OR MORE distinct steps, your VERY FIRST action MUST be a \`task_update\` \
call laying out the entire plan (every item "pending", except set the first to "in_progress"). \
Do this before any other tool call.
- After EACH step finishes, immediately call \`task_update\` again with updated statuses: mark the \
just-finished item "completed" and set the next one to "in_progress". Keep EXACTLY ONE item \
"in_progress" at a time. Do not batch updates or wait until the end.
- Always send the COMPLETE list on every call (full replacement), not just the changed item.
- Only skip the checklist for a genuinely single-step request.`;

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
      this.post({
        kind: "settings",
        values,
        hasApiKey: false,
        mustConfigure: true,
      });
      this.post({ kind: "error", message: `API key for ${values.provider} required.` });
      return;
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
    this.current = {
      version: SESSION_FORMAT_VERSION,
      id: newSessionId(),
      name,
      projectDir: this.projectDir,
      provider: this.provider.name,
      model:
        this.settings.model.trim().length > 0
          ? this.settings.model.trim()
          : this.provider.defaultModel,
      createdAt: now,
      updatedAt: now,
      messages: [...this.agent.history()],
      usage: emptyUsage(),
    };
  }

  // -------- turn runner --------

  private async runTurn(input: string): Promise<void> {
    if (!this.agent) {
      this.post({ kind: "error", message: "Configure settings first." });
      this.post({ kind: "assistant_end" });
      return;
    }
    this.post({ kind: "assistant_start" });

    let latestUsage: { promptTokens: number; completionTokens: number } | undefined;
    let turnAddPrompt = 0;
    let turnAddCompletion = 0;

    try {
      await this.agent.send(input, {
        onContent: (delta) => this.post({ kind: "assistant_content", delta }),
        onAssistantEnd: (_msg, meta) => {
          if (meta.usage) {
            latestUsage = meta.usage;
            turnAddPrompt += meta.usage.promptTokens;
            turnAddCompletion += meta.usage.completionTokens;
          }
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
    const session: Session = {
      ...this.current,
      updatedAt: new Date().toISOString(),
      messages: [...this.agent.history()],
      ...(this.settings.tasks ? { tasks: [...this.agent.getTasks()] } : {}),
    };
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
:root { color-scheme: light dark; }
/* Override VSCode's default body padding so the chat hugs the sidebar edges. */
html, body { margin: 0 !important; padding: 0 !important; height: 100%; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
  color: var(--vscode-foreground); background: var(--vscode-editor-background); }
#root { display: flex; flex-direction: column; height: 100%; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
.topbar-btn { background: transparent; color: var(--vscode-foreground); border: none;
  padding: 4px 8px; border-radius: 3px; cursor: pointer; font: inherit; }
.topbar-btn:hover { background: var(--vscode-list-hoverBackground); }
.topbar-session { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 70%;
  color: var(--vscode-descriptionForeground); }
.topbar-session b { color: var(--vscode-foreground); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar-menu { font-size: 14px; line-height: 1; }
.popover { position: absolute; background: var(--vscode-menu-background, var(--vscode-editor-background));
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 4px;
  padding: 4px; min-width: 180px; box-shadow: 0 4px 14px rgba(0,0,0,0.3); z-index: 50;
  color: var(--vscode-menu-foreground, var(--vscode-foreground)); }
.popover-cmd button { display: block; width: 100%; text-align: left; padding: 6px 10px;
  background: transparent; color: inherit; border: none; font: inherit; cursor: pointer; border-radius: 2px; }
.popover-cmd button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); }
.popover-cmd .divider { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; }
.popover-info { padding: 10px 12px; font-size: 12px; line-height: 1.6; }
.popover-info .row { display: flex; justify-content: space-between; gap: 14px; white-space: nowrap; }
.popover-info .row .k { opacity: 0.65; }
.task-card { background: var(--vscode-editorWidget-background); border-left: 2px solid var(--vscode-charts-blue);
  border-radius: 2px; padding: 6px 10px; margin: 6px 0; font-size: 12px; line-height: 1.45; }
.task-card .role { font-weight: 600; font-size: 10px; text-transform: uppercase; opacity: 0.6;
  letter-spacing: 0.6px; margin-bottom: 4px; }
.task-card ul { list-style: none; padding: 0; margin: 0; }
.task-card li { padding: 1px 0; display: flex; gap: 8px; align-items: baseline; }
.task-card .done { color: var(--vscode-charts-green); }
.task-card .inprogress { font-weight: 600; color: var(--vscode-charts-yellow); }
.task-card .pending { opacity: 0.55; }
.messages { flex: 1; overflow-y: auto; padding: 8px 6px 12px; }
.msg { margin-bottom: 10px; line-height: 1.5; }
.msg .role { font-weight: 600; font-size: 10px; text-transform: uppercase; opacity: 0.55; letter-spacing: 0.6px; margin-bottom: 2px; }
.msg.user .role { color: var(--vscode-charts-blue); }
.msg.assistant .role { color: var(--vscode-charts-purple); }
.msg .body { word-wrap: break-word; }
.msg.user .body { white-space: pre-wrap; }
/* Markdown content gets its own block spacing — keep tight but readable */
.msg .body > p { margin: 4px 0; }
.msg .body > p:first-child { margin-top: 0; }
.msg .body > p:last-child { margin-bottom: 0; }
.msg .body > ul, .msg .body > ol { margin: 4px 0; padding-left: 22px; }
.msg .body li { margin: 1px 0; }
.msg .body li > p { margin: 0; }
.msg .body > h1, .msg .body > h2, .msg .body > h3, .msg .body > h4 { margin: 10px 0 4px; line-height: 1.3; font-weight: 600; }
.msg .body > h1 { font-size: 1.15em; }
.msg .body > h2 { font-size: 1.08em; }
.msg .body > h3, .msg .body > h4 { font-size: 1em; }
.msg .body > h1:first-child, .msg .body > h2:first-child, .msg .body > h3:first-child { margin-top: 0; }
.msg .body > blockquote { margin: 6px 0; padding: 0 10px; border-left: 2px solid var(--vscode-textBlockQuote-border);
  background: var(--vscode-textBlockQuote-background); opacity: 0.9; }
.msg .body > pre { background: var(--vscode-textBlockQuote-background);
  padding: 8px 10px; margin: 6px 0; overflow-x: auto; border-radius: 3px; line-height: 1.4; }
.msg .body code { background: var(--vscode-textBlockQuote-background); padding: 1px 4px; border-radius: 2px;
  font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
.msg .body pre code { background: transparent; padding: 0; font-size: 0.9em; }
.msg .body > hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
.tool { font-size: 12px; padding: 6px 10px; margin: 6px 0; border-left: 2px solid var(--vscode-textLink-foreground);
  background: var(--vscode-editorWidget-background); border-radius: 2px; }
.tool .head { color: var(--vscode-textLink-foreground); font-weight: 600; font-size: 11px; }
.tool .args, .tool .result { white-space: pre-wrap; word-break: break-all; opacity: 0.85; margin-top: 4px;
  font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.4; }
.tool.hidden-mode { font-style: italic; color: var(--vscode-descriptionForeground); }
.notice { padding: 6px 10px; margin: 6px 0; border-radius: 2px; font-size: 12px; white-space: pre-wrap; line-height: 1.45; }
.notice.info { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }
.notice.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
.notice.warn { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
.composer { border-top: 1px solid var(--vscode-panel-border); padding: 6px; display: flex;
  gap: 4px; align-items: flex-end; }
.composer textarea { flex: 1; resize: none; min-height: 28px; max-height: 160px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 6px 10px;
  font-family: inherit; font-size: inherit; line-height: 1.4; outline: none; }
.composer textarea:focus { border-color: var(--vscode-focusBorder); }
.composer button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: 50%; width: 28px; height: 28px; padding: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: background 0.15s, opacity 0.15s; }
.composer button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.composer button:disabled { opacity: 0.35; cursor: default; }
.composer button svg { display: block; }

/* Settings modal */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 18px 20px; width: min(480px, 92vw); max-height: 92vh; overflow-y: auto; }
.modal h3 { margin: 0 0 10px; }
.modal .form-row { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
.modal .form-row label { font-size: 12px; opacity: 0.8; }
.modal .form-row.inline { flex-direction: row; align-items: center; gap: 8px; }
.modal .form-row.inline label { flex: 1; opacity: 1; }
.modal input[type="text"], .modal input[type="password"], .modal input[type="number"], .modal select {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 6px 8px; font: inherit;
}
.modal input[type="checkbox"] { accent-color: var(--vscode-button-background); }
.modal .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.modal .modal-actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; }
.modal .modal-actions button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
.modal .help { font-size: 11px; opacity: 0.7; margin-top: 2px; }
.modal .must-configure { padding: 8px 10px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 3px; margin-bottom: 12px; font-size: 12px; }

/* Loading / pending indicator */
.pending { display: flex; gap: 8px; align-items: center; padding: 4px 0; opacity: 0.7; font-size: 12px; }
.spin { display: inline-block; animation: sp-rotate 0.9s linear infinite; }
@keyframes sp-rotate { to { transform: rotate(360deg); } }
.thinking-dot::before { content: "◴"; display: inline-block; animation: sp-rotate 0.9s linear infinite; }
.msg .body .thinking-dot { display: inline-block; opacity: 0.6; }
`;
