import * as vscode from "vscode";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  Agent,
  buildSystemPrompt,
  clearSessions,
  createDefaultRegistry,
  createProvider,
  deleteSession,
  findByNameOrId,
  listSessions,
  loadSession,
  newSessionId,
  saveOptimizedView,
  saveOptimizedMiddleView,
  saveSession,
  saveSessionSync,
  SESSION_FORMAT_VERSION,
  optimizeContext,
  uploadsDirFor,
  type Provider,
  type Session,
  type Task,
  type ToolRegistry,
} from "@siberflow/core";
import type {
  BannerInfo,
  ExtToView,
  DocKind,
  HistoryMessage,
  OptimizeMode,
  PickedFile,
  ProviderName,
  SessionInfo,
  SettingsValues,
  ViewToExt,
} from "./protocol.js";
import type { Message } from "@siberflow/core";

const VERSION = "0.1.0";

/**
 * Resolve the absolute path to the puppeteer-core package directory from the
 * extension's perspective. The host knows the extension's real install dir
 * (extensionPath) — core does not, because in a VSCode extension process
 * .execPath is the VSCode binary, not the extension.
 *
 * We try, in order:
 *   1. <extensionPath>/vendor/puppeteer-core — packaged VSIX. The build pipeline
 *      (scripts/stage-puppeteer.mjs) copies puppeteer-core here before `vsce
 *      package`, because vsce ignores ALL of node_modules/.
 *   2. <extensionPath>/node_modules/puppeteer-core — a real local install (rare
 *      in this monorepo due to npm hoisting, but covers standalone installs).
 *   3. Walk UP from <extensionPath> looking for a node_modules/puppeteer-core —
 *      covers the DEBUG case, where the extension runs from its source folder
 *      inside the workspace and puppeteer-core is hoisted to the workspace
 *      root's node_modules/.
 *
 * Returns the package directory (NOT the main entry file — core reads
 * package.json's "main" field itself), or undefined if nothing was found.
 */
function resolvePuppeteerCorePath(extensionPath: string): string | undefined {
  const candidates = [
    join(extensionPath, "vendor", "puppeteer-core"),
    join(extensionPath, "node_modules", "puppeteer-core"),
  ];
  // Walk up from the extension dir to find a hoisted node_modules. This is the
  // common DEBUG layout: <workspace>/packages/vscode-ext (extensionPath) with
  // the dep hoisted to <workspace>/node_modules.
  let dir = extensionPath;
  for (let i = 0; i < 8; i++) {
    const parent = join(dir, "..");
    if (parent === dir) break; // reached filesystem root
    candidates.push(join(parent, "node_modules", "puppeteer-core"));
    dir = parent;
  }
  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) return c;
  }
  return undefined;
}

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
  private turnAbort: AbortController | null = null;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Siberflow needs an open workspace folder.");
    }
    this.projectDir = folder.uri.fsPath;
    this.settings = readSettings();
    // Tell core where puppeteer-core lives. In a VSCode extension,
    // process.execPath is the VSCode binary itself, so core's own resolution
    // heuristics (which key off execPath / cwd) can't find it. The host is the
    // only place that KNOWS the extension's real install dir, so we resolve the
    // package here and hand core the absolute path via this env var.
    // See core/src/tools/browser/browser.ts resolvePuppeteerCorePath().
    const ppPath = resolvePuppeteerCorePath(this.ctx.extensionPath);
    if (ppPath) {
      process.env.SIBERFLOW_PUPPETEER_CORE_PATH = ppPath;
    }
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
      case "regenerate":
        await this.regenerate();
        break;
      case "edit_last":
        await this.editLast(msg.input);
        break;
      case "stop":
        this.stopTurn();
        break;
      case "command":
        await this.runCommand(msg.command);
        break;
      case "save_settings":
        await this.saveSettings(msg.values, msg.apiKey);
        break;
      case "pick_doc_files":
        await this.pickDocFiles();
        break;
      case "answer_user":
        this.resolveUserAnswer(msg.id, msg.status, msg.answer);
        break;
    }
  }

  /**
   * Open a multi-select .xlsx file picker, copy each chosen file into the
   * workspace's `_uploads/` sandbox, and notify the webview with the resulting
   * relative paths (or an error message if it failed). Mirrors the desktop
   * app's `pickDocFiles` IPC handler.
   */
  private async pickDocFiles(): Promise<void> {
    if (this.turnAbort) {
      this.post({ kind: "info", message: "Tunggu turn selesai sebelum upload." });
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      title: "Pilih file dokumen",
      filters: {
        "Dokumen": ["xlsx", "docx", "pdf"],
        "Excel Workbook": ["xlsx"],
        "Word Document": ["docx"],
        "PDF Document": ["pdf"],
      },
      canSelectMany: true,
      openLabel: "Upload",
    });
    if (!uris || uris.length === 0) return; // user cancelled
    try {
      const files = await this.copyUploads(uris);
      this.post({ kind: "doc_files_picked", files });
    } catch (err) {
      this.post({ kind: "doc_pick_error", message: (err as Error).message });
    }
  }

  /**
   * Copy source file URIs into the session's per-session upload dir in the OS
   * tmp folder (NOT the workspace — keeps the project clean and out of git).
   * Returns metadata with absolute destination paths + `kind` so the agent can
   * be told the matching tool (`excel_script` / `docx_script` / `pdf_script`),
   * which whitelists this dir via the agent's `uploadDir` option. The folder is
   * removed automatically when the session is deleted.
   * Requires `this.current` to be set (so we know which session owns the dir).
   */
  private async copyUploads(srcUris: vscode.Uri[]): Promise<PickedFile[]> {
    if (!this.current) {
      throw new Error("Tidak ada session aktif.");
    }
    const destDir = uploadsDirFor(this.current.id);
    // mode 0o700: owner-only, so other users on a shared Linux box can't read
    // uploaded docs out of /tmp.
    await mkdir(destDir, { recursive: true, mode: 0o700 });
    const usedNames = new Set<string>();
    const out: PickedFile[] = [];
    for (const uri of srcUris) {
      const original = basename(uri.fsPath);
      const lower = original.toLowerCase();
      let kind: DocKind;
      if (lower.endsWith(".xlsx")) kind = "excel";
      else if (lower.endsWith(".docx")) kind = "docx";
      else if (lower.endsWith(".pdf")) kind = "pdf";
      else throw new Error(`File "${original}" bukan .xlsx/.docx/.pdf. Hanya dokumen yang didukung.`);
      const safe = sanitizeFileName(original, usedNames);
      usedNames.add(safe);
      const dest = join(destDir, safe);
      await copyFile(uri.fsPath, dest);
      await stat(dest); // sanity check it landed
      // relPath is the ABSOLUTE tmp path — the *_script tools resolve absolute
      // paths against the upload dir whitelist. (Field name kept for protocol
      // stability; semantically it's an absolute path now.)
      out.push({ name: original, kind, relPath: dest });
    }
    return out;
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
      cfg.update("contextOptimize", values.contextOptimize, target),
      cfg.update("contextOptimizeMode", values.contextOptimizeMode, target),
      cfg.update("autoContinue", values.autoContinue, target),
      cfg.update("hideTools", values.hideTools, target),
      cfg.update("debug", values.debug, target),
      cfg.update("maxIterations", values.maxIterations, target),
      cfg.update("requestDelayMs", values.requestDelayMs, target),
      cfg.update("enabledTools", values.enabledTools, target),
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
      if (this.agent) {
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
    this.registry = createDefaultRegistry({
      enabledTools: new Set(this.settings.enabledTools),
    });
    this.agent = this.buildAgent();
    if (this.current) {
      this.agent.loadHistory(this.current.messages);
      if (this.current.tasks?.length) {
        this.agent.loadTasks(this.current.tasks);
      }
    }
  }

  private buildAgent(): Agent {
    if (!this.provider || !this.registry) throw new Error("provider not ready");
    const modelOverride = this.settings.model.trim();
    const model =
      modelOverride.length > 0 ? modelOverride : this.provider.defaultModel;
    const systemPrompt = buildSystemPrompt({
      interface: "vscode",
      summaryMode: this.summaryModeActive(),
      enabledToolNames: this.registry.list().map((t) => t.name),
    });
    // uploadDir is the per-session tmp dir where uploaded Excels live. Pass it
    // so excel_script can whitelist reads from there even though it's outside
    // the project sandbox.
    const uploadDir = this.current ? uploadsDirFor(this.current.id) : undefined;
    return new Agent({
      provider: this.provider,
      registry: this.registry,
      model,
      systemPrompt,
      projectDir: this.projectDir,
      ...(uploadDir ? { uploadDir } : {}),
      askUser: (req) => this.askUserViaWebview(req),
      contextOptimize: this.optimizeConfig(),
      tasksEnabled: true,
      autoContinue: this.settings.autoContinue,
      maxIterations: this.settings.maxIterations,
      requestDelayMs: this.settings.requestDelayMs,
    });
  }

  /** Pending ask_user prompts keyed by id. */
  private pendingUserQuestions = new Map<
    string,
    { resolve: (resp: { status: "answer" | "cancel"; answer: string }) => void }
  >();

  private askUserViaWebview(req: {
    question: string;
    choices?: string[];
    allowFreeText?: boolean;
    defaultChoice?: string;
  }): Promise<{ status: "answer" | "cancel"; answer: string }> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      this.pendingUserQuestions.set(id, { resolve });
      this.post({
        kind: "ask_user",
        id,
        question: req.question,
        choices: req.choices ?? [],
        allowFreeText: req.allowFreeText ?? false,
        ...(req.defaultChoice ? { defaultChoice: req.defaultChoice } : {}),
      });
    });
  }

  /** Resolve a pending ask_user prompt (called when the webview posts back). */
  private resolveUserAnswer(id: string, status: "answer" | "cancel", answer: string): void {
    const entry = this.pendingUserQuestions.get(id);
    if (!entry) return;
    this.pendingUserQuestions.delete(id);
    entry.resolve({ status, answer });
  }

  /** Whether summary-mode optimization is currently in effect. */
  private summaryModeActive(): boolean {
    // Breadcrumb ([SUMMARY] tags) is emitted in both "summary" and "recent"
    // modes — they differ only in WHICH turns get compressed, not in the
    // breadcrumb format. So the SUMMARY_GUIDANCE prompt applies to both.
    return (
      this.settings.contextOptimize &&
      (this.settings.contextOptimizeMode === "summary" ||
        this.settings.contextOptimizeMode === "recent")
    );
  }

  /** Build the ContextOptimizeConfig shared by the agent and persisters. */
  private optimizeConfig(): {
    enabled: boolean;
    mode?: "drop" | "summary" | "recent";
  } {
    return {
      enabled: this.settings.contextOptimize,
      ...(this.settings.contextOptimizeMode !== "recent"
        ? { mode: this.settings.contextOptimizeMode }
        : {}),
    };
  }

  private postReady(): void {
    this.post({
      kind: "ready",
      banner: this.banner(),
      session: this.sessionInfo(),
      hideTools: this.settings.hideTools,
      tasksEnabled: true,
      enabledTools: this.settings.enabledTools,
    });
    if (this.current && this.current.messages.length > 0) {
      this.post({
        kind: "history",
        messages: filterHistory(this.current.messages),
      });
    }
    if (this.agent) {
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
    if (session.tasks?.length) {
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
      const { messages: optimized } = optimizeContext(
        this.current.messages,
        this.optimizeConfig(),
      );
      if (this.summaryModeActive()) {
        void saveOptimizedMiddleView(this.current, optimized);
      } else {
        void saveOptimizedView(this.current, optimized);
      }
    }
  }

  // -------- turn runner --------

  private async runTurn(input: string): Promise<void> {
    if (this.turnAbort) {
      this.post({ kind: "info", message: "A turn is already running." });
      return;
    }
    if (!this.agent) {
      this.post({ kind: "error", message: "Configure settings first." });
      this.post({ kind: "assistant_end" });
      return;
    }
    const abort = new AbortController();
    this.turnAbort = abort;
    let latestUsage: { promptTokens: number; completionTokens: number } | undefined;
    let turnAddPrompt = 0;
    let turnAddCompletion = 0;

    try {
      await this.agent.send(input, {
        signal: abort.signal,
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
      if (isAbortError(err)) {
        this.post({ kind: "tasks", tasks: this.agent.getTasks() as Task[] });
        this.post({ kind: "info", message: "generation stopped" });
      } else {
        this.post({ kind: "error", message: (err as Error).message });
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
      this.post({ kind: "assistant_end" });
    }
  }

  private stopTurn(): void {
    this.turnAbort?.abort();
  }

  /**
   * Re-run the last user turn: rewind history to that user message (dropping
   * its response + any tool calls) and re-send the same prompt. The webview
   * also rewinds its DOM so the new response streams into a clean view.
   */
  private async regenerate(): Promise<void> {
    if (this.turnAbort) {
      this.post({ kind: "info", message: "A turn is already running." });
      return;
    }
    if (!this.agent) {
      this.post({ kind: "error", message: "Configure settings first." });
      this.post({ kind: "assistant_end" });
      return;
    }
    const last = this.agent.rewindToLastUserMessage();
    if (last === null) {
      this.post({ kind: "info", message: "Nothing to regenerate." });
      this.post({ kind: "assistant_end" });
      return;
    }
    await this.runTurn(last);
  }

  /**
   * Replace the last user message with `input` and re-run. Like regenerate
   * but swaps the prompt text first. Rewind cleans any dangling tool_calls.
   */
  private async editLast(input: string): Promise<void> {
    if (this.turnAbort) {
      this.post({ kind: "info", message: "A turn is already running." });
      return;
    }
    if (!this.agent) {
      this.post({ kind: "error", message: "Configure settings first." });
      this.post({ kind: "assistant_end" });
      return;
    }
    const last = this.agent.rewindToLastUserMessage();
    if (last === null) {
      this.post({ kind: "info", message: "Nothing to edit." });
      this.post({ kind: "assistant_end" });
      return;
    }
    await this.runTurn(input);
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
      tasks: [...this.agent.getTasks()],
    };
    await saveSession(session);
    this.current = session;
    if (this.settings.contextOptimize) {
      const { messages: optimized } = optimizeContext(
        session.messages,
        this.optimizeConfig(),
      );
      if (this.summaryModeActive()) {
        await saveOptimizedMiddleView(session, optimized);
      } else {
        await saveOptimizedView(session, optimized);
      }
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
    this.post({ kind: "tasks", tasks: [] });
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
    if (session.tasks?.length) {
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
      this.post({ kind: "tasks", tasks: [] });
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
    this.post({ kind: "tasks", tasks: [] });
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
    contextOptimize: cfg.get<boolean>("contextOptimize", true),
    contextOptimizeMode: cfg.get<OptimizeMode>("contextOptimizeMode", "recent"),
    autoContinue: cfg.get<boolean>("autoContinue", true),
    hideTools: cfg.get<boolean>("hideTools", false),
    debug: cfg.get<boolean>("debug", false),
    maxIterations: cfg.get<number>("maxIterations", 50),
    requestDelayMs: cfg.get<number>("requestDelayMs", 1500),
    enabledTools: cfg.get<string[]>("enabledTools", [
      "read_file", "write_file", "edit_file", "copy_file", "list_dir",
    ]),
  };
}

/**
 * Sanitize an uploaded filename for safe storage inside the workspace sandbox:
 * keep alphanumerics, dot, dash, underscore; collapse everything else to a
 * dash; de-duplicate against `used` by appending `-2`, `-3`, … before `.xlsx`.
 */
function sanitizeFileName(original: string, used: Set<string>): string {
  const lower = original.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  const cleanedStem = stem.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "file";
  let candidate = `${cleanedStem}.xlsx`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${cleanedStem}-${n}.xlsx`;
    n++;
  }
  return candidate;
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

const INLINE_CSS = `
:root {
  color-scheme: light dark;
  /* Borders */
  --sf-border: color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
  --sf-border-strong: color-mix(in srgb, var(--vscode-panel-border) 90%, var(--vscode-foreground) 10%);
  /* Text */
  --sf-muted: color-mix(in srgb, var(--vscode-descriptionForeground) 86%, var(--vscode-foreground) 14%);
  /* Surfaces — three elevation levels */
  --sf-surface: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background) 18%);
  --sf-surface-alt: color-mix(in srgb, var(--vscode-editorWidget-background) 70%, var(--vscode-editor-background) 30%);
  --sf-surface-raised: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, var(--vscode-editor-background) 12%);
  /* Accents */
  --sf-accent: var(--vscode-textLink-foreground);
  --sf-accent-soft: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
  --sf-user: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
  --sf-assistant: color-mix(in srgb, var(--vscode-editorWidget-background) 60%, var(--vscode-editor-background) 40%);
  --sf-glow: color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent);
  /* Shadows — kept flat/minimal */
  --sf-shadow-xs: 0 1px 1px rgba(0,0,0,0.06);
  --sf-shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
  --sf-shadow: 0 2px 8px rgba(0,0,0,0.10);
  --sf-shadow-lg: 0 4px 16px rgba(0,0,0,0.14);
  /* Radius — kept small for a flat look */
  --sf-radius: 8px;
  --sf-radius-sm: 6px;
  --sf-radius-xs: 4px;
}
html, body { margin: 0 !important; padding: 0 !important; height: 100%; }
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: 12px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#root { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }

/* ---------- Topbar ---------- */
.topbar {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sf-border);
  background: var(--vscode-editor-background);
}
.topbar-brand { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.brand-icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--sf-accent);
  flex-shrink: 0;
}
.brand-icon svg { width: 100%; height: 100%; }
.topbar-btn {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid transparent;
  padding: 5px;
  border-radius: var(--sf-radius-sm);
  cursor: pointer;
  font: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.14s ease, color 0.14s ease;
}
.topbar-btn:hover {
  background: color-mix(in srgb, var(--vscode-list-hoverBackground) 90%, transparent);
}
.topbar-menu {
  font-size: 16px;
  line-height: 1;
  justify-self: end;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--sf-muted);
}
.topbar-menu:hover { color: var(--vscode-foreground); }

/* ---------- Popover menu ---------- */
.popover {
  position: absolute;
  background: color-mix(in srgb, var(--vscode-menu-background, var(--vscode-editorWidget-background)) 96%, black 4%);
  border: 1px solid var(--sf-border-strong);
  border-radius: var(--sf-radius-sm);
  padding: 4px;
  min-width: 200px;
  box-shadow: var(--sf-shadow);
  z-index: 60;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  animation: sf-popover 140ms ease-out;
}
@keyframes sf-popover {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.popover-cmd button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  text-align: left;
  padding: 6px 8px;
  background: transparent;
  color: inherit;
  border: none;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  border-radius: var(--sf-radius-xs);
  transition: background 0.1s ease, color 0.1s ease;
}
.popover-cmd button svg { width: 13px; height: 13px; opacity: 0.7; flex-shrink: 0; }
.popover-cmd button:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
}
.popover-cmd button:hover svg { opacity: 1; }
.popover-cmd .divider { height: 1px; background: var(--sf-border); margin: 5px 4px; }

/* ---------- Messages container ---------- */
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 11px;
  scroll-behavior: smooth;
}

/* ---------- Empty state ---------- */
.empty-state {
  margin: auto;
  padding: 24px 16px;
  text-align: center;
  max-width: 300px;
  border: none;
  background: transparent;
}
.empty-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--sf-accent-soft);
  color: var(--sf-accent);
}
.empty-icon svg { width: 24px; height: 24px; }
.empty-title {
  font-size: 13px;
  line-height: 1.4;
  font-weight: 600;
  margin-bottom: 5px;
  color: var(--vscode-foreground);
}
.empty-copy {
  color: var(--sf-muted);
  line-height: 1.5;
  font-size: 11px;
  margin-bottom: 14px;
}
.empty-copy code {
  font-family: var(--vscode-editor-font-family);
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 80%, transparent);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-xs);
  padding: 1px 4px;
  font-size: 0.92em;
}
.empty-actions {
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: stretch;
}
.empty-chip {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  font: inherit;
  font-size: 11px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--sf-surface-alt) 70%, transparent);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.empty-chip:hover {
  background: var(--sf-accent-soft);
  border-color: color-mix(in srgb, var(--sf-accent) 40%, var(--sf-border));
}

/* ---------- Message rows (label on top + full-width body) ---------- */
.msg {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 100%;
}
.msg .role {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sf-muted);
  padding: 0 1px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.msg.user .role { color: color-mix(in srgb, var(--vscode-button-background) 80%, var(--sf-muted)); }
.msg.assistant .role { color: var(--sf-accent); }
.msg .role .role-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.msg .body {
  width: 100%;
  min-width: 0;
  word-wrap: break-word;
  overflow-wrap: anywhere;
  border-radius: var(--sf-radius-sm);
  padding: 8px 11px;
  line-height: 1.5;
}
.msg.user .body {
  white-space: pre-wrap;
  background: color-mix(in srgb, var(--sf-user) 80%, var(--vscode-editor-background) 20%);
  border: 1px solid color-mix(in srgb, var(--vscode-button-background) 24%, var(--sf-border));
}
.msg.assistant .body {
  background: color-mix(in srgb, var(--sf-assistant) 80%, transparent);
  border: 1px solid var(--sf-border);
}
/* Placeholder assistant turn (no text segments yet, e.g. waiting on tools). */
.msg.assistant:not(:has(.seg)) .body {
  border-style: dashed;
  padding: 7px 10px;
  background: color-mix(in srgb, var(--sf-surface-alt) 60%, transparent);
}
.msg.assistant:not(:has(.seg)) .role { opacity: 0.55; }

/* Markdown typography inside body */
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
.msg .body h1 { font-size: 1.1em; }
.msg .body h2 { font-size: 1.04em; }
.msg .body h3, .msg .body h4 { font-size: 1em; }
.msg .body .seg > h1:first-child, .msg .body .seg > h2:first-child, .msg .body .seg > h3:first-child { margin-top: 0; }
.msg .body a { color: var(--vscode-textLink-foreground); text-decoration-thickness: 1px; }
.msg .body blockquote {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--sf-accent);
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 70%, transparent);
  border-radius: 0 var(--sf-radius-xs) var(--sf-radius-xs) 0;
}
.msg .body pre {
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 72%, black 14%);
  border: 1px solid var(--sf-border);
  padding: 10px 12px;
  margin: 8px 0;
  max-width: 100%;
  overflow-x: auto;
  border-radius: var(--sf-radius-sm);
  line-height: 1.5;
}
.msg .body code {
  background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 70%, transparent);
  border: 1px solid var(--sf-border);
  padding: 1px 5px;
  border-radius: var(--sf-radius-xs);
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
}
.msg .body pre code { background: transparent; border: none; padding: 0; font-size: 0.92em; }
.msg .body table { border-collapse: collapse; margin: 8px 0; font-size: 0.92em; }
.msg .body th, .msg .body td { border: 1px solid var(--sf-border); padding: 4px 8px; }
.msg .body th { background: color-mix(in srgb, var(--sf-surface-alt) 60%, transparent); }
.msg .body hr { border: none; border-top: 1px solid var(--sf-border); margin: 10px 0; }
.msg .body .seg { white-space: pre-wrap; }
.msg .body .seg:has(> p), .msg .body .seg:has(> ul), .msg .body .seg:has(> ol),
.msg .body .seg:has(> h1), .msg .body .seg:has(> h2), .msg .body .seg:has(> h3),
.msg .body .seg:has(> pre), .msg .body .seg:has(> blockquote) { white-space: normal; }

/* ---------- Tool blocks ---------- */
.tool {
  font-size: 11px;
  padding: 7px 9px;
  margin: 6px 0;
  border: 1px solid var(--sf-border);
  background: color-mix(in srgb, var(--sf-surface-raised) 86%, transparent);
  border-radius: var(--sf-radius-sm);
}
.tool .head {
  color: var(--sf-accent);
  font-weight: 600;
  font-size: 10px;
  letter-spacing: 0.01em;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.tool .head:hover { opacity: 0.82; }
.tool .tool-icon { width: 12px; height: 12px; opacity: 0.8; flex-shrink: 0; }
.tool .tool-label { display: inline-flex; align-items: center; gap: 5px; }
.tool .tool-chevron { font-size: 9px; opacity: 0.65; width: 10px; display: inline-block; text-align: center; }
.tool .tool-body { transition: opacity 0.15s ease; }
.tool.collapsed .tool-body { display: none; }
.tool .args, .tool .result {
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.88;
  margin-top: 6px;
  font-family: var(--vscode-editor-font-family);
  font-size: 10px;
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
.tool.hidden-mode .head { color: var(--sf-muted); cursor: default; }
.tool.hidden-summary .head { display: flex; align-items: center; gap: 7px; }
.tool.hidden-summary .summary-meta {
  margin-top: 5px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--sf-muted);
  word-break: break-word;
}

/* ---------- Notices ---------- */
.notice {
  padding: 7px 10px;
  border-radius: var(--sf-radius-sm);
  font-size: 11px;
  white-space: pre-wrap;
  line-height: 1.4;
  border: 1px solid transparent;
}
.notice.info { background: color-mix(in srgb, var(--vscode-inputValidation-infoBackground) 78%, transparent); border-color: color-mix(in srgb, var(--vscode-inputValidation-infoBorder) 70%, transparent); }
.notice.error { background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 78%, transparent); border-color: color-mix(in srgb, var(--vscode-inputValidation-errorBorder) 70%, transparent); }
.notice.warn { background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground) 78%, transparent); border-color: color-mix(in srgb, var(--vscode-inputValidation-warningBorder) 70%, transparent); }

/* ---------- Task panel ---------- */
.task-panel {
  margin: 0 10px 8px;
  border: 1px solid var(--sf-border);
  background: color-mix(in srgb, var(--sf-surface-alt) 80%, transparent);
  border-radius: var(--sf-radius-sm);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  flex: 0 0 auto;
}
.task-panel-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  gap: 7px;
}
.task-panel-header:hover { background: color-mix(in srgb, var(--vscode-list-hoverBackground) 70%, transparent); }
.task-panel-title { color: var(--sf-muted); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; flex-shrink: 0; }
.task-panel-title b { color: var(--vscode-foreground); font-weight: 700; }
.task-panel-progress {
  flex: 1;
  height: 3px;
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  border-radius: 2px;
  overflow: hidden;
  max-width: 70px;
}
.task-panel-progress-fill {
  height: 100%;
  background: var(--sf-accent);
  border-radius: 2px;
  transition: width 0.3s ease;
}
.task-panel-chevron { font-size: 8px; opacity: 0.6; width: 8px; text-align: center; flex-shrink: 0; }
.task-panel-body {
  padding: 2px 10px 8px;
  max-height: 220px;
  overflow-y: auto;
  border-top: 1px solid var(--sf-border);
  transition: max-height 0.2s ease, opacity 0.2s ease, padding 0.2s ease;
}
.task-panel-body ul { list-style: none; padding: 6px 0 0; margin: 0; }
.task-panel-body li {
  padding: 3px 0;
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  line-height: 1.4;
}
.task-panel-body .task-ico {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.task-panel-body .task-ico svg { width: 100%; height: 100%; }
.task-panel-body .task-text { flex: 1; min-width: 0; }
.task-panel-body .done { color: var(--vscode-foreground); }
.task-panel-body .done .task-ico { color: var(--vscode-charts-green); }
.task-panel-body .done .task-text { text-decoration: line-through; opacity: 0.6; }
.task-panel-body .inprogress { color: var(--vscode-foreground); font-weight: 600; }
.task-panel-body .inprogress .task-ico { color: var(--vscode-charts-yellow); }
.task-panel-body .pending { color: var(--sf-muted); }
.task-panel-body .pending .task-ico { opacity: 0.5; }
.task-panel.collapsed .task-panel-body { max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; }

/* ---------- Composer ---------- */
.composer {
  padding: 8px 10px 6px;
  border-top: 1px solid var(--sf-border);
  background: var(--vscode-editor-background);
}
.composer-shell {
  display: flex;
  gap: 6px;
  align-items: flex-end;
  padding: 5px 5px 5px 7px;
  border: 1px solid var(--sf-border-strong);
  border-radius: var(--sf-radius-sm);
  background: var(--vscode-input-background);
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
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
  padding: 4px 4px;
  font-family: inherit;
  font-size: inherit;
  line-height: 1.45;
  outline: none;
}
.composer textarea::placeholder { color: var(--sf-muted); }
.composer button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: var(--sf-radius-xs);
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  transition: opacity 0.15s ease, filter 0.15s ease, transform 0.1s ease;
}
.composer button.stop {
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-button-background));
  color: var(--vscode-inputValidation-warningForeground, var(--vscode-button-foreground));
  animation: sf-pulse 1.8s ease-in-out infinite;
}
.composer button:hover:not(:disabled) { filter: brightness(1.08); }
.composer button:active:not(:disabled) { transform: scale(0.96); }
.composer button:disabled { opacity: 0.35; cursor: default; filter: none; }
.composer button svg { display: block; }
.composer-hint {
  padding: 4px 3px 0;
  font-size: 9px;
  color: var(--sf-muted);
  display: flex;
  align-items: center;
  gap: 5px;
}
.composer-hint kbd {
  font-family: var(--vscode-editor-font-family);
  font-size: 8px;
  background: color-mix(in srgb, var(--sf-surface-alt) 70%, transparent);
  border: 1px solid var(--sf-border);
  border-radius: 3px;
  padding: 0 3px;
  line-height: 1.5;
}

/* ---------- Excel attachment chips + upload button ---------- */
.composer-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 6px;
  padding: 0 2px;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 200px;
  padding: 4px 6px 4px 8px;
  background: color-mix(in srgb, #1d6f42 14%, var(--sf-surface-alt));
  border: 1px solid color-mix(in srgb, #1d6f42 32%, var(--sf-border));
  border-radius: 999px;
  font-size: 11px;
  line-height: 1;
  color: var(--vscode-foreground);
  animation: sf-enter 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.attach-chip .attach-chip-icon {
  width: 13px;
  height: 13px;
  color: #1d6f42;
  flex-shrink: 0;
}
.attach-chip .attach-chip-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.attach-chip .attach-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--sf-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.attach-chip .attach-chip-x:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  color: var(--vscode-foreground);
}
.upload-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--sf-radius-xs);
  color: var(--sf-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.upload-btn:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}
.upload-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.upload-btn svg { display: block; }

/* ---------- Settings modal ---------- */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: sf-fade 160ms ease-out;
}
@keyframes sf-fade { from { opacity: 0; } to { opacity: 1; } }
.modal {
  background: var(--vscode-editor-background);
  border: 1px solid var(--sf-border-strong);
  border-radius: var(--sf-radius);
  padding: 16px;
  width: min(520px, 92vw);
  max-height: 92vh;
  overflow-y: auto;
  box-shadow: var(--sf-shadow-lg);
  animation: sf-modal-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes sf-modal-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.modal h3 {
  margin: 0 0 3px;
  font-size: 13px;
  font-weight: 700;
}
.modal .modal-subtitle { font-size: 10px; color: var(--sf-muted); margin-bottom: 12px; }
.modal .form-section { margin-top: 14px; }
.modal .form-section-title {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sf-muted);
  margin-bottom: 3px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--sf-border);
}
.modal .tools-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 12px;
  margin: 8px 0 4px;
}
.modal .tool-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--vscode-foreground);
  padding: 3px 0;
  cursor: pointer;
}
.modal .tool-toggle input[type="checkbox"] { margin: 0; cursor: pointer; }
.modal .tool-toggle .tool-toggle-name {
  font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
}
.modal .tool-toggle .tool-toggle-group {
  margin-left: auto;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--sf-muted);
  opacity: 0.7;
}
.modal .form-row { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.modal .form-row label { font-size: 11px; opacity: 0.85; }
.modal .form-row.inline { flex-direction: row; align-items: center; gap: 10px; }
.modal .form-row.inline label { flex: 1; opacity: 1; cursor: pointer; }
.modal input[type="text"], .modal input[type="password"], .modal input[type="number"], .modal select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--sf-border-strong);
  border-radius: var(--sf-radius-xs);
  padding: 5px 8px;
  font: inherit;
  font-size: 11px;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.modal input[type="text"]:focus, .modal input[type="password"]:focus, .modal input[type="number"]:focus, .modal select:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 1px var(--sf-glow);
}
.modal input[type="checkbox"] {
  accent-color: var(--vscode-button-background);
  width: 14px;
  height: 14px;
  cursor: pointer;
}
.modal .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--sf-border); }
.modal .modal-actions button {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  padding: 6px 14px;
  border-radius: var(--sf-radius-xs);
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  transition: filter 0.14s ease, transform 0.1s ease;
}
.modal .modal-actions button:hover { filter: brightness(1.08); }
.modal .modal-actions button:active { transform: scale(0.97); }
.modal .modal-actions button.secondary {
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid var(--sf-border-strong);
}
.modal .help { font-size: 10px; opacity: 0.65; margin-top: 2px; }
.modal .must-configure {
  padding: 7px 10px;
  background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground) 80%, transparent);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: var(--sf-radius-xs);
  margin-bottom: 12px;
  font-size: 11px;
}

/* ---------- Pending / thinking ---------- */
.pending {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 1px;
  border: none;
  color: var(--sf-muted);
  background: transparent;
  align-self: flex-start;
  font-size: 11px;
  margin-left: 1px;
}
.thinking-dots { display: inline-flex; align-items: center; gap: 4px; }
.thinking-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sf-accent);
  animation: sf-bounce 1.2s infinite ease-in-out both;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
@keyframes sf-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.45; }
  30% { transform: translateY(-5px); opacity: 1; }
}
.spin { display: inline-block; animation: sp-rotate 0.9s linear infinite; }
@keyframes sp-rotate { to { transform: rotate(360deg); } }
.thinking-dot::before { content: ""; }
.msg .body .thinking-dot { display: none; }

/* ---------- Entrance / leave animations ---------- */
.msg, .tool, .pending, .notice {
  animation: sf-enter 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes sf-enter {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.pending.leaving { animation: sf-leave 160ms ease-in forwards; }
@keyframes sf-leave {
  from { opacity: 1; }
  to   { opacity: 0; transform: translateY(-2px); }
}

/* Stop button press feedback + pulse. */
.composer button.stop.pressed { animation: sf-press 0.42s ease-out, sf-pulse 1.8s ease-in-out infinite; }
@keyframes sf-press {
  0%   { transform: scale(1); }
  30%  { transform: scale(0.93); }
  100% { transform: scale(1); }
}
@keyframes sf-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.78; }
}

/* ---------- Action bar under last assistant message ---------- */
.msg .actions {
  display: flex;
  gap: 6px;
  margin: 5px 0 0 1px;
  padding: 0;
  animation: sf-enter 160ms ease-out;
}
.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  color: var(--sf-muted);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-xs);
  padding: 2px 7px;
  font-size: 10px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, transform 0.1s ease;
}
.action-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
  border-color: var(--sf-border-strong);
}
.action-btn:active { transform: scale(0.96); }
.action-btn svg { opacity: 0.85; }

/* ---------- Copy button on code blocks ---------- */
.msg .body pre { position: relative; }
.msg .body pre .code-copy {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 24px;
  height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--vscode-editorWidget-background) 85%, transparent);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-xs);
  color: var(--vscode-foreground);
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease;
}
.msg .body pre:hover .code-copy { opacity: 0.9; }
.msg .body pre .code-copy:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.msg .body pre .code-copy.copied { color: var(--vscode-charts-green); opacity: 1; }

/* ---------- Jump-to-bottom button ---------- */
#jump-bottom {
  position: absolute;
  right: 14px;
  bottom: 92px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--sf-border-strong);
  border-radius: var(--sf-radius-sm);
  color: var(--vscode-foreground);
  cursor: pointer;
  opacity: 0;
  transform: translateY(6px);
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease, background 0.14s ease;
  box-shadow: var(--sf-shadow-xs);
  z-index: 40;
}
#jump-bottom.visible {
  opacity: 0.9;
  transform: translateY(0);
  pointer-events: auto;
}
#jump-bottom:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }

/* ---------- Reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
  .msg, .tool, .pending, .notice, .pending.leaving, .modal, .popover,
  .composer button.stop, .composer button.stop.pressed, .tool .tool-body,
  .task-panel-body, .thinking-dots span {
    animation: none !important;
    transition: none !important;
  }
  .messages { scroll-behavior: auto; }
}

/* ---------- ask_user modal ---------- */
.ask-user-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: sf-enter 150ms ease;
  outline: none;
}
.ask-user-modal {
  background: var(--vscode-editor-background);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-md, 8px);
  max-width: 600px;
  width: 92%;
  max-height: 80vh;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ask-user-header {
  padding: 10px 16px;
  border-bottom: 1px solid var(--sf-border);
  display: flex;
  align-items: center;
}
.ask-user-badge {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sf-accent, #0e639c);
  background: var(--vscode-list-inactiveSelectionBackground, var(--sf-surface-alt));
  padding: 2px 8px;
  border-radius: 999px;
}
.ask-user-question {
  padding: 14px 16px 4px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  white-space: pre-wrap;
  color: var(--vscode-foreground);
}
.ask-user-body {
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.ask-user-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 16px;
}
.ask-user-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  background: transparent;
  color: var(--vscode-foreground);
  border: 1px solid transparent;
  border-radius: var(--sf-radius-sm, 4px);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.ask-user-item:hover {
  background: var(--vscode-list-hoverBackground);
}
.ask-user-item.selected {
  background: var(--vscode-list-inactiveSelectionBackground, var(--sf-surface-alt));
  border-color: var(--sf-accent, #0e639c);
}
.ask-user-num {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--sf-muted);
  background: var(--vscode-list-inactiveSelectionBackground, var(--sf-surface-alt));
  border-radius: 4px;
  margin-top: 1px;
}
.ask-user-item.selected .ask-user-num {
  color: #fff;
  background: var(--sf-accent, #0e639c);
}
.ask-user-item-label {
  flex: 1;
  line-height: 1.5;
}
.ask-user-freetext-item {
  align-items: flex-start;
}
.ask-user-text-input {
  width: 100%;
  resize: vertical;
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm, 4px);
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
}
.ask-user-text-input:focus {
  outline: none;
  border-color: var(--sf-accent, #0e639c);
}
.ask-user-hint {
  padding: 0 16px 8px;
  font-size: 10px;
  color: var(--sf-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}
.ask-user-hint kbd {
  display: inline-block;
  padding: 0 4px;
  font-size: 9px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-list-inactiveSelectionBackground, var(--sf-surface-alt));
  border: 1px solid var(--sf-border);
  border-radius: 3px;
  line-height: 1.6;
}
.ask-user-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-top: 1px solid var(--sf-border);
  gap: 8px;
}
.ask-user-cancel-btn {
  padding: 6px 16px;
  background: transparent;
  color: var(--sf-muted);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm, 4px);
  font-size: 12px;
  cursor: pointer;
}
.ask-user-cancel-btn:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
}
.ask-user-submit-btn {
  padding: 6px 18px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  border-radius: var(--sf-radius-sm, 4px);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.ask-user-submit-btn:disabled { opacity: 0.4; cursor: default; }
`;
