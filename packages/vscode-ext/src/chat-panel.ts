import * as vscode from "vscode";
import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
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
  parseProviderHeadersEnv,
  uploadsDirFor,
  type Provider,
  type ProviderConfig,
  type Session,
  type Task,
  type ToolRegistry,
} from "@siberflow/core";
import type {
  AttachmentKind,
  BannerInfo,
  ExtToView,
  HistoryMessage,
  OptimizeMode,
  PickedFile,
  ProviderName,
  ReasoningEffort,
  SessionInfo,
  SettingsValues,
  ViewToExt,
} from "./protocol.js";
import type { Message } from "@siberflow/core";

const VERSION = "0.6.4";

/** SiberGate gateway base URL (must match core/providers registry). */
const SIBERGATE_BASE_URL = "https://api.idsiber.com/v1";
/** Static vision model for analyze_image when the provider is SiberGate. */
const SIBERGATE_VISION_MODEL = "ds-vision-flash";
/** SiberGate's Exa-compatible web-search endpoint (gateway passthrough). */
const SIBERGATE_EXA_BASE_URL = "https://api.idsiber.com/v1/generic/exa/";

/** Default settings shared with the desktop app (protocol parity). */
const DEFAULT_SETTINGS: SettingsValues = {
  provider: "sibergate",
  customProvider: { name: "custom", baseUrl: "", defaultModel: "" },
  multimodalProvider: { baseUrl: "https://api.openai.com/v1", model: "" },
  model: "",
  reasoningEffort: "none",
  maxTokens: 50000,
  contextOptimize: true,
  contextOptimizeMode: "compact",
  contextWindow: 200000,
  compactThreshold: 0.8,
  compactKeepRecent: 2,
  autoContinue: true,
  preTruncate: false,
  hideTools: true,
  debug: false,
  subagent: false,
  maxIterations: 100,
  requestDelayMs: 100,
  enabledTools: [
    "read_file",
    "write_file",
    "edit_file",
    "copy_file",
    "delete_file",
    "list_dir",
    "grep",
    "exec",
    "run_browser",
  ],
};

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
  /** Tracks whether we've emitted the initial task-plan for the current turn. */
  private planEmittedForTurn = false;

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
        await this.send(msg.input);
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
        await this.saveSettings(msg.values, msg.apiKey, msg.multimodalApiKey, msg.exaApiKey);
        break;
      case "pick_doc_files":
        await this.pickDocFiles();
        break;
      case "get_image_preview":
        await this.sendImagePreview(msg.path);
        break;
      case "answer_user":
        this.resolveUserAnswer(msg.id, msg.status, msg.answer);
        break;
    }
  }

  /**
   * Open a multi-select file picker for supported documents and images, copy
   * each chosen file into the session's upload sandbox, and notify the webview
   * with the resulting metadata (or an error message if it failed). Mirrors
   * the desktop app's `pickFiles` IPC handler.
   */
  private async pickDocFiles(): Promise<void> {
    if (this.turnAbort) {
      this.post({ kind: "info", message: "Tunggu turn selesai sebelum upload." });
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      title: "Pilih file dokumen atau gambar",
      filters: {
        "Dokumen & Gambar": ["xlsx", "docx", "pdf", "png", "jpg", "jpeg", "webp", "gif"],
        "Excel Workbook": ["xlsx"],
        "Word Document": ["docx"],
        "PDF Document": ["pdf"],
        "Images": ["png", "jpg", "jpeg", "webp", "gif"],
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
   * Returns metadata with absolute destination paths + `kind` (excel / docx /
   * pdf / image) so the agent can be told the matching tool, which whitelists
   * this dir via the agent's `uploadDir` option. The folder is removed
   * automatically when the session is deleted.
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
      let kind: AttachmentKind;
      if (lower.endsWith(".xlsx")) kind = "excel";
      else if (lower.endsWith(".docx")) kind = "docx";
      else if (lower.endsWith(".pdf")) kind = "pdf";
      else if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].some((ext) => lower.endsWith(ext))) kind = "image";
      else throw new Error(`File "${original}" bukan format yang didukung (.xlsx/.docx/.pdf/.png/.jpg/.jpeg/.webp/.gif).`);
      const safe = sanitizeFileName(original, usedNames);
      usedNames.add(safe);
      const dest = join(destDir, safe);
      await copyFile(uri.fsPath, dest);
      const stats = await stat(dest); // sanity check it landed
      // relPath is the ABSOLUTE tmp path — the *_script tools resolve absolute
      // paths against the upload dir whitelist. (Field name kept for protocol
      // stability; semantically it's an absolute path now.)
      out.push({ name: original, kind, relPath: dest, bytes: stats.size });
    }
    return out;
  }

  /**
   * Read an uploaded image as a data URL for the webview chat preview.
   * Resolve and validate both paths so the webview cannot use this channel to
   * read arbitrary files from the machine. Mirrors the desktop host.
   */
  private async sendImagePreview(imagePath: string): Promise<void> {
    const session = this.current;
    if (!session || !isAbsolute(imagePath)) {
      this.post({ kind: "image_preview", path: imagePath, dataUrl: null });
      return;
    }
    const uploadDir = uploadsDirFor(session.id);
    try {
      const [uploadReal, imageReal] = await Promise.all([realpath(uploadDir), realpath(imagePath)]);
      const rel = relative(uploadReal, imageReal);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        this.post({ kind: "image_preview", path: imagePath, dataUrl: null });
        return;
      }
      const mime = mimeForImage(imageReal);
      if (!mime) {
        this.post({ kind: "image_preview", path: imagePath, dataUrl: null });
        return;
      }
      const file = await readFile(imageReal);
      if (file.byteLength > 20 * 1024 * 1024) {
        this.post({ kind: "image_preview", path: imagePath, dataUrl: null });
        return;
      }
      this.post({ kind: "image_preview", path: imagePath, dataUrl: `data:${mime};base64,${file.toString("base64")}` });
    } catch {
      this.post({ kind: "image_preview", path: imagePath, dataUrl: null });
    }
  }

  // -------- init / settings --------

  private async onInit(): Promise<void> {
    this.settings = readSettings();
    this.apiKey = await this.loadApiKey(this.settings.provider);
    if (this.settings.debug) process.env.SIBERFLOW_DEBUG = "true";
    else delete process.env.SIBERFLOW_DEBUG;
    await this.applyMultimodalEnv();
    await this.applyExaEnv();

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
    await this.applyMultimodalEnv();
    await this.applyExaEnv();
    this.post({
      kind: "settings",
      values: this.settings,
      hasApiKey: !!this.apiKey,
      hasMultimodalApiKey: !!(await this.loadMultimodalApiKey()),
      hasExaApiKey: !!(await this.loadExaApiKey()),
      mustConfigure,
    });
  }

  private async saveSettings(
    values: SettingsValues,
    apiKey: string | null,
    multimodalApiKey: string | null,
    exaApiKey: string | null,
  ): Promise<void> {
    values = normalizeSettings(values);
    if (values.provider === "custom" && (!values.customProvider.baseUrl || !values.customProvider.defaultModel)) {
      this.post({ kind: "error", message: "Custom provider needs a base URL and default model." });
      return;
    }
    const prevSettings = this.settings;
    const cfg = vscode.workspace.getConfiguration("siberflow");
    const target = vscode.ConfigurationTarget.Global;
    await Promise.all([
      cfg.update("provider", values.provider, target),
      cfg.update("customProvider", values.customProvider, target),
      cfg.update("multimodalProvider", values.multimodalProvider, target),
      cfg.update("model", values.model, target),
      cfg.update("reasoningEffort", values.reasoningEffort, target),
      cfg.update("maxTokens", values.maxTokens, target),
      cfg.update("contextOptimize", values.contextOptimize, target),
      cfg.update("contextOptimizeMode", values.contextOptimizeMode, target),
      cfg.update("contextWindow", values.contextWindow, target),
      cfg.update("compactThreshold", values.compactThreshold, target),
      cfg.update("compactKeepRecent", values.compactKeepRecent, target),
      cfg.update("autoContinue", values.autoContinue, target),
      cfg.update("preTruncate", values.preTruncate, target),
      cfg.update("hideTools", values.hideTools, target),
      cfg.update("debug", values.debug, target),
      cfg.update("subagent", values.subagent, target),
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
    await this.applyMultimodalEnv(multimodalApiKey);
    await this.applyExaEnv(exaApiKey);

    if (!this.apiKey) {
      this.readyForChat = false;
      this.provider = null;
      this.registry = null;
      this.agent = null;
      this.post({
        kind: "settings",
        values,
        hasApiKey: false,
        hasMultimodalApiKey: !!(await this.loadMultimodalApiKey()),
        hasExaApiKey: !!(await this.loadExaApiKey()),
        mustConfigure: true,
      });
      this.post({ kind: "error", message: `API key for ${values.provider} required.` });
      return;
    }

    if (this.current) {
      this.current.provider = displayProviderName(values);
      this.current.model =
        values.model.trim().length > 0
          ? values.model.trim()
          : createProvider(values.provider, this.providerConfig(values)).defaultModel;
      this.current.updatedAt = new Date().toISOString();
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

  private async loadMultimodalApiKey(): Promise<string | null> {
    const v = await this.ctx.secrets.get(multimodalSecretKey());
    return v ?? null;
  }

  private async applyMultimodalEnv(apiKeyInput: string | null = null): Promise<void> {
    // SiberGate: multimodal (analyze_image) is fully automatic — same endpoint
    // + API key as the active provider, static vision model. The user must NOT
    // configure it (the UI hides these fields).
    if (this.settings.provider === "sibergate") {
      process.env.SIBERFLOW_MULTIMODAL_BASE_URL = SIBERGATE_BASE_URL;
      process.env.SIBERFLOW_MULTIMODAL_MODEL = SIBERGATE_VISION_MODEL;
      if (apiKeyInput !== null) await this.persistMultimodalKey(apiKeyInput);
      if (this.apiKey) process.env.SIBERFLOW_MULTIMODAL_API_KEY = this.apiKey;
      else delete process.env.SIBERFLOW_MULTIMODAL_API_KEY;
      return;
    }
    const baseUrl = this.settings.multimodalProvider.baseUrl.trim().replace(/\/+$/, "");
    const model = this.settings.multimodalProvider.model.trim();
    if (baseUrl) process.env.SIBERFLOW_MULTIMODAL_BASE_URL = baseUrl;
    else delete process.env.SIBERFLOW_MULTIMODAL_BASE_URL;
    if (model) process.env.SIBERFLOW_MULTIMODAL_MODEL = model;
    else delete process.env.SIBERFLOW_MULTIMODAL_MODEL;

    if (apiKeyInput !== null) {
      await this.persistMultimodalKey(apiKeyInput);
    }
    const key = await this.loadMultimodalApiKey();
    if (key) process.env.SIBERFLOW_MULTIMODAL_API_KEY = key;
    else delete process.env.SIBERFLOW_MULTIMODAL_API_KEY;
  }

  /** Store/clear the standalone multimodal API key (non-sibergate providers). */
  private async persistMultimodalKey(apiKeyInput: string): Promise<void> {
    if (apiKeyInput.length > 0) await this.ctx.secrets.store(multimodalSecretKey(), apiKeyInput);
    else await this.ctx.secrets.delete(multimodalSecretKey());
  }

  /**
   * Web search (Exa) API key handling. The key gates whether the web_search
   * tool can be enabled in the UI — the toggle is disabled until a key is
   * stored, so the model never sees the tool without a usable credential.
   */
  private async loadExaApiKey(): Promise<string | null> {
    const v = await this.ctx.secrets.get(exaSecretKey());
    return v ?? null;
  }

  private async applyExaEnv(apiKeyInput: string | null = null): Promise<void> {
    // SiberGate: web_search is fully automatic — use the gateway's Exa endpoint
    // and the active provider's API key. The user must NOT configure it (the
    // UI hides the Exa key field and force-enables the web_search toggle).
    if (this.settings.provider === "sibergate") {
      if (apiKeyInput !== null) await this.persistExaKey(apiKeyInput);
      process.env.SIBERFLOW_EXA_BASE_URL = SIBERGATE_EXA_BASE_URL;
      if (this.apiKey) process.env.SIBERFLOW_EXA_API_KEY = this.apiKey;
      else delete process.env.SIBERFLOW_EXA_API_KEY;
      return;
    }
    if (apiKeyInput !== null) {
      await this.persistExaKey(apiKeyInput);
    }
    const key = await this.loadExaApiKey();
    if (key) process.env.SIBERFLOW_EXA_API_KEY = key;
    else delete process.env.SIBERFLOW_EXA_API_KEY;
  }

  /** Store/clear the standalone Exa API key (non-sibergate providers). */
  private async persistExaKey(apiKeyInput: string): Promise<void> {
    if (apiKeyInput.length > 0) await this.ctx.secrets.store(exaSecretKey(), apiKeyInput);
    else await this.ctx.secrets.delete(exaSecretKey());
  }

  private rebuildAgent(): void {
    if (!this.apiKey) return;
    this.provider = createProvider(this.settings.provider, this.providerConfig());
    // Sub-agents (agent_general / agent_explorer) are opt-in via the `subagent`
    // setting (default OFF). When enabled, add both tool names to the enabled
    // set so they pass the per-name filter, and open the factory gate below.
    const enabledTools = new Set(this.settings.enabledTools);
    if (this.settings.subagent) {
      enabledTools.add("agent_general");
      enabledTools.add("agent_explorer");
    }
    // SiberGate: web_search is always active — its endpoint + key are wired
    // automatically (applyExaEnv), so the model can use it without any setup.
    if (this.settings.provider === "sibergate") {
      enabledTools.add("web_search");
    }
    const modelOverride = this.settings.model.trim();
    const model =
      modelOverride.length > 0 ? modelOverride : this.provider.defaultModel;
    this.registry = createDefaultRegistry({
      enabledTools,
      provider: this.provider,
      model,
      subagent: this.settings.subagent,
      subagentMaxIterations: this.settings.maxIterations,
    });
    this.agent = this.buildAgent();
    if (this.current) {
      this.agent.loadHistory(this.current.messages);
      if (this.current.tasks?.length) {
        this.agent.loadTasks(this.current.tasks);
      }
      this.agent.loadSummary(this.current.summary ?? null);
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
    // uploadDir is the per-session tmp dir where uploaded documents/images
    // live. Pass it so the *_script and analyze_image tools can whitelist
    // reads from there even though it's outside the project sandbox.
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
      preTruncate: this.settings.preTruncate,
      maxIterations: this.settings.maxIterations,
      maxTokens: this.settings.maxTokens,
      requestDelayMs: this.settings.requestDelayMs,
      // VSCode may be launched from Finder/Dock without the terminal PATH.
      // Let exec load the user's login shell profile so node/npm and tools
      // managed by Homebrew, nvm, fnm, or asdf are discoverable.
      execShellMode: "login-interactive",
      // Persist checkpoints while a turn is running, so the completed part of
      // an aborted turn stays available for resume.
      preservePartialHistoryOnAbort: true,
      // Seed the compact-mode threshold trigger with the resumed session's
      // last prompt size (contextSize = last iteration's prompt, accurate
      // context window — not the turn-accumulated promptTokens).
      ...(this.current?.usage?.last?.contextSize
        ? { lastPromptTokens: this.current.usage.last.contextSize }
        : {}),
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
    // "compact" mode is excluded: it produces its own LLM narrative summary,
    // so the deterministic-breadcrumb guidance doesn't apply there.
    return (
      this.settings.contextOptimize &&
      (this.settings.contextOptimizeMode === "summary" ||
        this.settings.contextOptimizeMode === "recent")
    );
  }

  /** Build the ContextOptimizeConfig shared by the agent and persisters. */
  private optimizeConfig(): {
    enabled: boolean;
    mode?: "drop" | "summary" | "recent" | "compact";
    contextWindow?: number;
    compactThreshold?: number;
    compactKeepRecent?: number;
  } {
    return {
      enabled: this.settings.contextOptimize,
      ...(this.settings.contextOptimizeMode !== "compact"
        ? { mode: this.settings.contextOptimizeMode }
        : {}),
      // Surface compact-mode tuning only when that mode is active, so other
      // modes aren't cluttered with irrelevant config.
      ...(this.settings.contextOptimizeMode === "compact"
        ? {
            contextWindow: this.settings.contextWindow,
            compactThreshold: this.settings.compactThreshold,
            compactKeepRecent: this.settings.compactKeepRecent,
          }
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
      values: this.settings,
    });
    if (this.current && this.current.messages.length > 0) {
      this.post({
        kind: "history",
        messages: filterHistory(this.current.messages),
      });
    }
    if (this.agent) {
      // restored=true keeps the resumed checklist hidden until a live update
      // arrives — mirrors the desktop TaskPanel behavior.
      this.post({ kind: "tasks", tasks: this.agent.getTasks() as Task[], restored: true });
    }
    // Seed the context-usage bar with the resumed session's last prompt size.
    if (this.current) {
      this.post({
        kind: "usage",
        usage: this.current.usage,
        optSaved: this.optSavedBytes,
      });
    }
  }

  // -------- session resume on first open --------

  /**
   * On startup, resume the most recently used session for this workspace if
   * one exists, so reopening the panel doesn't prompt every time. Only create
   * a fresh session when there are no prior sessions at all. Mirrors the
   * desktop AgentHost.init().
   */
  private async pickSessionOnStart(): Promise<void> {
    const recent = await listSessions({ projectDir: this.projectDir });
    if (recent.length === 0) {
      this.startNewSession(null);
      return;
    }
    const session = await loadSession(recent[0]!.id);
    if (!session || !this.agent) {
      this.startNewSession(null);
      return;
    }
    this.agent.loadHistory(session.messages);
    if (session.tasks?.length) {
      this.agent.loadTasks(session.tasks);
    }
    // Restore the LLM compact summary (if any) so "compact" mode keeps rolling
    // it forward instead of restarting from scratch on resume.
    this.agent.loadSummary(session.summary ?? null);
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
    // Rebuild so the agent's uploadDir matches the new session id.
    this.rebuildAgent();
    saveSessionSync(this.current);
    this.writeOptimizedView();
    // Notify the webview so the chat area resets immediately (ready clears
    // the transcript, history/tasks/usage seed the fresh state).
    this.postReady();
  }

  // -------- turn runner --------

  async send(input: string): Promise<void> {
    // Auto-name the session from the first user message if it has no name yet.
    // Takes a substring of the prompt: up to 5 words, truncated at a word
    // boundary near 50 chars, with the first letter capitalized.
    if (this.current && this.current.name === null) {
      const firstUserSeen = this.current.messages.some((m) => m.role === "user");
      if (!firstUserSeen) {
        this.current.name = deriveSessionName(input);
        this.current.updatedAt = new Date().toISOString();
        saveSessionSync(this.current);
        this.post({ kind: "session_changed", session: this.sessionInfo() });
      }
    }
    return this.runTurn(input);
  }

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
    this.planEmittedForTurn = false;
    const initialTaskCount = this.agent.getTasks().length;
    let turnAddPrompt = 0;
    let turnAddCompletion = 0;
    let usageApplied = false;
    let agentCompleted = false;
    const continuationNotice = this.current?.pendingTurnNotice?.trim();
    // Track the LAST iteration's prompt size so usage.last.contextSize
    // reflects the actual context the model saw (not the turn accumulation).
    let lastIterPrompt = 0;

    try {
      await this.agent.send(input, {
        signal: abort.signal,
        ...(continuationNotice ? { continuationNotice } : {}),
        onAssistantStart: () => this.post({ kind: "assistant_start" }),
        onContent: (delta) => this.post({ kind: "assistant_content", delta }),
        onReasoning: (delta) => this.post({ kind: "reasoning", delta }),
        onAssistantEnd: (_msg, meta) => {
          if (meta.usage) {
            turnAddPrompt += meta.usage.promptTokens;
            turnAddCompletion += meta.usage.completionTokens;
            lastIterPrompt = meta.usage.promptTokens;
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
        onToolBatchStart: (count) =>
          this.post({ kind: "tool_batch_start", count }),
        onToolBatchEnd: () => this.post({ kind: "tool_batch_end" }),
        onToolRoundEnd: () => this.post({ kind: "tool_round_end" }),
        onTasksUpdated: (tasks) => {
          const taskList = tasks as Task[];
          // Emit task-plan once per turn when tasks are first populated.
          if (!this.planEmittedForTurn && initialTaskCount === 0 && taskList.length > 0) {
            this.planEmittedForTurn = true;
            this.post({ kind: "task_plan", tasks: taskList });
          }
          this.post({ kind: "tasks", tasks: taskList });
          if (this.current) {
            this.current.tasks = [...taskList];
            this.current.updatedAt = new Date().toISOString();
            try {
              saveSessionSync(this.current);
            } catch {
              /* best-effort */
            }
          }
        },
        onContextOptimized: (stats) => {
          this.optSavedBytes += stats.bytesSaved;
          this.post({ kind: "context_optimized", bytesSaved: stats.bytesSaved });
        },
        onContextCompacting: () => this.post({ kind: "context_compacting" }),
        onContextCompacted: (stats) =>
          this.post({
            kind: "context_compacted",
            turnsSummarized: stats.turnsSummarized,
            summaryChars: stats.summaryChars,
          }),
        onSubagentUpdate: (phase, detail) =>
          this.post({ kind: "subagent_update", phase, detail }),
        onMaxIterations: (limit) => this.post({ kind: "max_iterations", limit }),
        onHistoryChanged: () => this.persistCheckpointSync(),
      });

      agentCompleted = true;
      if (this.current) delete this.current.pendingTurnNotice;
      this.applyTurnUsage(turnAddPrompt, turnAddCompletion, lastIterPrompt);
      usageApplied = true;
      await this.persistAfterTurn();
    } catch (err) {
      // A failed/stopped turn can still contain completed assistant/tool
      // iterations. Persist that partial history before reporting the error;
      // otherwise the next launch resumes from the last successful turn.
      if (!agentCompleted && this.current) {
        this.current.pendingTurnNotice = isAbortError(err)
          ? "The previous turn was stopped before the assistant produced its final response. " +
            "Continue from the persisted tool results and do not repeat completed side effects."
          : "The previous turn was interrupted by an error before the assistant produced its final response. " +
            "All persisted tool calls and results are authoritative; continue from the latest state " +
            "and do not repeat completed side effects.";
      }
      if (!usageApplied) {
        this.applyTurnUsage(turnAddPrompt, turnAddCompletion, lastIterPrompt);
        usageApplied = true;
      }
      try {
        await this.persistAfterTurn();
      } catch (persistErr) {
        this.post({
          kind: "error",
          message: `Could not save partial history: ${(persistErr as Error).message}`,
        });
      }
      if (isAbortError(err)) {
        if (this.agent) this.post({ kind: "tasks", tasks: this.agent.getTasks() as Task[] });
        this.post({ kind: "info", message: "generation stopped" });
      } else {
        this.post({ kind: "error", message: (err as Error).message });
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
      this.post({ kind: "assistant_end" });
    }
  }

  private applyTurnUsage(
    promptTokens: number,
    completionTokens: number,
    contextSize: number,
  ): void {
    if (!this.current) return;
    // usage.last.promptTokens = accumulated usage across iterations in this
    // turn; contextSize remains the prompt size of the last completed call.
    this.current.usage.last = {
      promptTokens,
      completionTokens,
      contextSize,
    };
    this.current.usage.total.promptTokens += promptTokens;
    this.current.usage.total.completionTokens += completionTokens;
  }

  /** Persist a small synchronous checkpoint after each history mutation. */
  private persistCheckpointSync(): void {
    if (!this.current || !this.agent) return;
    const summary = this.agent.summaryState();
    const session: Session = {
      ...this.current,
      updatedAt: new Date().toISOString(),
      messages: [...this.agent.history()],
      tasks: [...this.agent.getTasks()],
      ...(summary ? { summary } : {}),
    };
    if (!summary) delete session.summary;
    try {
      saveSessionSync(session);
      this.current = session;
    } catch {
      // The final async persist will retry; a checkpoint must not interrupt
      // the agent loop when the session directory is temporarily unavailable.
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
      ...(this.agent.summaryState()
        ? { summary: this.agent.summaryState()! }
        : {}),
    };
    await saveSession(session);
    this.current = session;
    this.writeOptimizedView();
    this.post({ kind: "session_changed", session: this.sessionInfo() });
    // Push the updated usage so the webview's context-usage bar reflects the
    // turn just completed (previously only sent on the manual /usage command).
    this.post({
      kind: "usage",
      usage: this.current!.usage,
      optSaved: this.optSavedBytes,
    });
  }

  private writeOptimizedView(): void {
    if (!this.current || !this.settings.contextOptimize || !this.agent) return;
    const { messages: optimized } = optimizeContext(
      this.current.messages,
      this.optimizeConfig(),
      this.agent.summaryState(),
    );
    if (this.summaryModeActive()) {
      void saveOptimizedMiddleView(this.current, optimized);
    } else {
      void saveOptimizedView(this.current, optimized);
    }
  }

  // -------- slash commands --------

  private async cmdNew(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "New session name (optional)",
      placeHolder: "feature-x (or leave empty)",
    });
    if (name === undefined) return;
    // startNewSession posts ready/history/tasks/usage itself.
    this.startNewSession(name.trim().length > 0 ? name.trim() : null);
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
    this.agent.loadSummary(session.summary ?? null);
    this.current = session;
    this.post({ kind: "session_changed", session: this.sessionInfo() });
    this.post({ kind: "history", messages: filterHistory(session.messages) });
    // restored=true keeps the resumed checklist hidden until a live update.
    this.post({ kind: "tasks", tasks: (session.tasks ?? []) as Task[], restored: true });
    this.post({ kind: "usage", usage: this.current.usage, optSaved: this.optSavedBytes });
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
      // Active session deleted — start a fresh one so the composer never
      // points at a dangling agent with no session to persist into.
      this.startNewSession(null);
      this.post({ kind: "info", message: `Deleted session "${target.name ?? target.id}"` });
      return;
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
    // All sessions wiped — start fresh so the composer persists somewhere.
    this.startNewSession(null);
    this.post({ kind: "info", message: `Cleared ${removed} session(s)` });
  }

  private cmdUsage(): void {
    if (!this.current) {
      this.post({ kind: "info", message: "no active session" });
      return;
    }
    // Push usage so the context bar refreshes, plus an info notice so the
    // /usage command still shows a visible summary (the auto usage events
    // from persistAfterTurn/postReady update the bar silently).
    this.post({
      kind: "usage",
      usage: this.current.usage,
      optSaved: this.optSavedBytes,
    });
    const u = this.current.usage;
    const ctx = u.last.contextSize ?? u.last.promptTokens;
    this.post({
      kind: "info",
      message: `context: ${ctx.toLocaleString()} tokens · last turn: ${u.last.promptTokens.toLocaleString()} prompt / ${u.last.completionTokens.toLocaleString()} completion · total: ${u.total.promptTokens.toLocaleString()} prompt / ${u.total.completionTokens.toLocaleString()} completion`,
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

  private providerConfig(settings: SettingsValues = this.settings): ProviderConfig {
    if (!this.apiKey) {
      throw new Error("API key is not configured.");
    }
    const headers = parseProviderHeadersEnv();
    if (settings.provider !== "custom") {
      return {
        apiKey: this.apiKey,
        reasoningEffort: settings.reasoningEffort,
        ...(headers ? { headers } : {}),
      };
    }
    return {
      apiKey: this.apiKey,
      baseUrl: settings.customProvider.baseUrl,
      reasoningEffort: settings.reasoningEffort,
      ...(headers ? { headers } : {}),
      customName: settings.customProvider.name,
      customDefaultModel: settings.customProvider.defaultModel,
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
 * Project the full persisted message history into a renderer-safe transcript
 * for the webview after a session is loaded. Mirrors the desktop's
 * HistoryEntry projection: assistant messages keep their toolCalls and tool
 * results come through as separate entries, so the webview can rebuild the
 * same text/tool-block layout the live stream produced.
 */
function filterHistory(messages: readonly Message[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              toolCalls: m.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: call.arguments,
              })),
            }
          : {}),
      });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        toolCallId: m.toolCallId,
        name: m.name,
        content: m.content,
      });
    }
  }
  return out;
}

function readSettings(): SettingsValues {
  const cfg = vscode.workspace.getConfiguration("siberflow");
  return {
    provider: cfg.get<ProviderName>("provider", "sibergate"),
    customProvider:
      cfg.get<SettingsValues["customProvider"]>("customProvider", {
        name: "custom",
        baseUrl: "",
        defaultModel: "",
      }) ?? { name: "custom", baseUrl: "", defaultModel: "" },
    multimodalProvider:
      cfg.get<SettingsValues["multimodalProvider"]>("multimodalProvider", {
        baseUrl: "https://api.openai.com/v1",
        model: "",
      }) ?? { baseUrl: "https://api.openai.com/v1", model: "" },
    model: cfg.get<string>("model", ""),
    reasoningEffort: cfg.get<ReasoningEffort>("reasoningEffort", "none"),
    maxTokens: cfg.get<number>("maxTokens", 50000),
    contextOptimize: cfg.get<boolean>("contextOptimize", true),
    contextOptimizeMode: cfg.get<OptimizeMode>("contextOptimizeMode", "compact"),
    contextWindow: cfg.get<number>("contextWindow", 200000),
    compactThreshold: cfg.get<number>("compactThreshold", 0.8),
    compactKeepRecent: cfg.get<number>("compactKeepRecent", 2),
    autoContinue: cfg.get<boolean>("autoContinue", true),
    preTruncate: cfg.get<boolean>("preTruncate", false),
    hideTools: cfg.get<boolean>("hideTools", true),
    debug: cfg.get<boolean>("debug", false),
    subagent: cfg.get<boolean>("subagent", false),
    maxIterations: cfg.get<number>("maxIterations", 100),
    requestDelayMs: cfg.get<number>("requestDelayMs", 100),
    enabledTools: cfg.get<string[]>("enabledTools", DEFAULT_SETTINGS.enabledTools),
  };
}

/**
 * Sanitize an uploaded filename for safe storage inside the upload sandbox:
 * keep alphanumerics, dot, dash, underscore; collapse everything else to a
 * dash; de-duplicate against `used` by appending `-2`, `-3`, … before the
 * ORIGINAL extension (a .docx upload must stay .docx).
 */
function sanitizeFileName(original: string, used: Set<string>): string {
  const lower = original.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  const extension = dot > 0 ? lower.slice(dot) : ".bin";
  const cleanedStem = stem.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "file";
  let candidate = `${cleanedStem}${extension}`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${cleanedStem}-${n}${extension}`;
    n++;
  }
  return candidate;
}

function secretKeyFor(provider: ProviderName): string {
  return `siberflow.apiKey.${provider}`;
}

function multimodalSecretKey(): string {
  return "siberflow.apiKey.multimodal";
}

function exaSecretKey(): string {
  return "siberflow.apiKey.exa";
}

function normalizeSettings(values: SettingsValues): SettingsValues {
  const customProvider = values.customProvider ?? { name: "custom", baseUrl: "", defaultModel: "" };
  const multimodalProvider = values.multimodalProvider ?? { baseUrl: "https://api.openai.com/v1", model: "" };
  const contextWindow = Number.isFinite(values.contextWindow) && values.contextWindow >= 1000
    ? Math.min(Math.floor(values.contextWindow), 2_000_000)
    : DEFAULT_SETTINGS.contextWindow;
  const maxTokensValue = Number(values.maxTokens);
  const maxTokens = Number.isFinite(maxTokensValue) && maxTokensValue > 0
    ? Math.min(Math.floor(maxTokensValue), 2_000_000)
    : DEFAULT_SETTINGS.maxTokens;
  const reasoningEffort =
    values.reasoningEffort === "low" ||
    values.reasoningEffort === "medium" ||
    values.reasoningEffort === "high" ||
    values.reasoningEffort === "max" ||
    values.reasoningEffort === "none"
      ? values.reasoningEffort
      : DEFAULT_SETTINGS.reasoningEffort;
  return {
    ...values,
    subagent: values.subagent === true,
    contextWindow,
    maxTokens,
    reasoningEffort,
    customProvider: {
      name: customProvider.name.trim() || "custom",
      baseUrl: customProvider.baseUrl.trim().replace(/\/+$/, ""),
      defaultModel: customProvider.defaultModel.trim(),
    },
    multimodalProvider: {
      baseUrl: multimodalProvider.baseUrl.trim().replace(/\/+$/, ""),
      model: multimodalProvider.model.trim(),
    },
  };
}

/**
 * Derive a short, human-readable session name from the first user prompt.
 * - Takes up to 5 words.
 * - Truncates at a word boundary near 50 characters (no mid-word cut).
 * - Capitalizes the first letter.
 * - Strips leading command prefixes like "tolong", "please", "coba", "bisa".
 */
function deriveSessionName(input: string): string {
  const STRIP_PREFIXES = [
    "tolong", "please", "tolonglah", "coba", "bisa", "bantu", "help",
    "minta", "saya", "aku", "gimana", "gmn", "how", "what", "why", "can you",
  ];
  const MAX_WORDS = 5;
  const MAX_CHARS = 50;

  let words = input.trim().replace(/\s+/g, " ").split(" ");
  // Drop leading filler words so the name starts with the real intent.
  while (words.length > 1 && STRIP_PREFIXES.includes(words[0]!.toLowerCase())) {
    words = words.slice(1);
  }
  words = words.slice(0, MAX_WORDS);

  let name = words.join(" ");
  // Truncate at the last word boundary that fits within MAX_CHARS.
  if (name.length > MAX_CHARS) {
    name = name.slice(0, MAX_CHARS);
    const lastSpace = name.lastIndexOf(" ");
    if (lastSpace > 15) name = name.slice(0, lastSpace);
    name = name.trimEnd() + "…";
  }

  // Capitalize the first character.
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return name || "New chat";
}

function mimeForImage(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

function displayProviderName(settings: SettingsValues): string {
  return settings.provider === "custom"
    ? settings.customProvider.name || "custom"
    : settings.provider;
}

function emptyUsage() {
  return {
    last: { promptTokens: 0, completionTokens: 0, contextSize: 0 },
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
  padding: 0;
  line-height: 1.5;
}
.msg.user .body {
  white-space: pre-wrap;
}
.msg.assistant .body {
  background: transparent;
  border: none;
}
/* Placeholder assistant turn (no text segments yet, e.g. waiting on tools). */
.msg.assistant:not(:has(.seg)) .body {
  background: transparent;
  border: none;
  padding: 0;
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

/* ---------- Tool group card (parallel batch) ---------- */
.tool-group {
  margin: 6px 0;
  padding: 7px 9px;
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  background: color-mix(in srgb, var(--sf-surface-raised) 86%, transparent);
}
.tool-group.running {
  border-color: var(--sf-accent);
  border-style: dashed;
}
.tool-group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--sf-accent);
  font-weight: 600;
  font-size: 10px;
  cursor: pointer;
  user-select: none;
}
.tool-group-head:hover { opacity: 0.82; }
.tool-group-head .tool-chevron { font-size: 9px; opacity: 0.65; width: 10px; }
.tool-group-head .tool-icon { width: 12px; height: 12px; opacity: 0.8; flex-shrink: 0; }
.tool-group-count { font-weight: 700; }
.tool-group-names {
  color: var(--sf-muted);
  font-weight: 400;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-group-status {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--sf-muted);
}
.tool-group-status.done { color: var(--sf-success, #4eaa78); }
.tool-group-body {
  margin-top: 8px;
  padding-left: 6px;
  border-left: 2px solid var(--sf-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tool-group.collapsed .tool-group-body { display: none; }
/* Nested tool blocks inside an expanded group: softer borders, tighter. */
.tool-group-body .tool {
  margin: 0;
  border-style: dashed;
  background: transparent;
}

/* ---------- Context usage bar (compact mode) ---------- */
.sf-context-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 0;
  font-size: 10px;
  color: var(--sf-muted);
}
.sf-context-track {
  flex: 1;
  height: 4px;
  background: var(--sf-border);
  border-radius: 2px;
  position: relative;
}
.sf-context-fill {
  height: 100%;
  border-radius: 2px;
  transition: width .3s ease, background .2s ease;
}
.sf-context-fill.ok { background: #4eaa78; }
.sf-context-fill.warn { background: #d4a72c; }
.sf-context-fill.danger { background: #e5484d; }
.sf-context-threshold {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 0;
  border-left: 1px dashed currentColor;
  opacity: 0.45;
}
.sf-context-text {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.sf-context-thresh-label { opacity: 0.65; }

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
  animation: sf-enter 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
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
.task-panel-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--sf-radius-xs);
  color: var(--sf-muted);
  font-size: 10px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.task-panel-close:hover { background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); color: var(--vscode-foreground); }
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
.task-panel-body .task-step-num { color: var(--sf-muted); font-size: 10px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.task-panel-body .task-text { flex: 1; min-width: 0; }
.task-panel-body .done { color: var(--vscode-foreground); }
.task-panel-body .done .task-ico { color: var(--vscode-charts-green); }
.task-panel-body .done .task-text { text-decoration: line-through; opacity: 0.6; }
.task-panel-body .inprogress { color: var(--vscode-foreground); font-weight: 600; }
.task-panel-body .inprogress .task-ico { color: var(--vscode-charts-yellow); }
.task-panel-body .pending { color: var(--sf-muted); }
.task-panel-body .pending .task-ico { opacity: 0.5; }
.task-panel.collapsed .task-panel-body { max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; }
/* Active step hint (plan mode) */
.task-active-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  border-bottom: 1px solid var(--sf-border);
  padding: 4px 0 8px;
  margin-bottom: 3px;
  color: var(--sf-muted);
  font-size: 10px;
}
.task-active-hint strong {
  color: var(--vscode-foreground);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.task-active-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sf-accent);
  animation: sf-pulse-dot 1.5s infinite;
}
.task-active-hint .thinking-dots { margin-left: auto; transform: scale(0.75); transform-origin: right center; }

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
/* When empty (e.g. while streaming, since the activity card now carries the
 * loading status), collapse the row so there is no dead gap under the input. */
.composer-hint:empty {
  display: none;
  padding: 0;
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

/* ---------- Thinking dots / spinners ---------- */
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
@keyframes sf-pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.8); }
}

/* ---------- Entrance / leave animations ---------- */
.msg, .tool, .notice {
  animation: sf-enter 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes sf-enter {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
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

/* ---------- Activity card (live agent phase indicator) ---------- */
.activity-card {
  display: flex;
  align-items: center;
  gap: 9px;
  width: fit-content;
  max-width: min(100%, 560px);
  margin: 2px 1px;
  padding: 7px 11px;
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-sm);
  background: color-mix(in srgb, var(--sf-surface-alt) 80%, transparent);
  color: var(--sf-muted);
  font-size: 11px;
  animation: sf-enter 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.activity-card.activity-tool { border-color: color-mix(in srgb, var(--vscode-charts-green) 45%, var(--sf-border)); }
.activity-card.activity-task { border-color: color-mix(in srgb, var(--vscode-charts-yellow) 45%, var(--sf-border)); }
.activity-card.activity-subagent { border-color: color-mix(in srgb, var(--vscode-charts-blue) 45%, var(--sf-border)); }
.activity-card.activity-context { border-color: color-mix(in srgb, var(--vscode-charts-purple, var(--sf-accent)) 45%, var(--sf-border)); }
.activity-spinner {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border: 2px solid var(--sf-border-strong);
  border-top-color: var(--sf-accent);
  border-radius: 50%;
  animation: sp-rotate 0.8s linear infinite;
}
.activity-copy { display: inline-flex; flex-direction: column; min-width: 0; }
.activity-copy strong { color: var(--vscode-foreground); font-weight: 600; }
.activity-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--sf-muted);
  font-size: 10px;
}
.activity-card .thinking-dots { margin-left: auto; }
.activity-card.leaving { animation: sf-leave 160ms ease-in forwards; }

/* ---------- User message attachments ---------- */
.msg.user .user-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.user-image-attachment {
  display: block;
  width: min(320px, 100%);
  max-height: 280px;
  object-fit: contain;
  background: var(--vscode-editor-background);
  border: 1px solid var(--sf-border-strong);
  border-radius: var(--sf-radius-sm);
}
.user-image-attachment.unavailable {
  padding: 16px;
  font-size: 11px;
  color: var(--sf-muted);
}
.user-file-attachment {
  padding: 7px 10px;
  border: 1px solid var(--sf-border-strong);
  border-radius: var(--sf-radius-xs);
  background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
  font-size: 11px;
  color: var(--vscode-foreground);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg.user .user-message-text { white-space: pre-wrap; }

/* ---------- Historical turns ("Show work") ---------- */
.work-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  margin: 0 0 8px;
  padding: 4px 9px;
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-xs);
  background: transparent;
  color: var(--sf-muted);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.work-toggle:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.work-toggle .tool-chevron { font-size: 8px; width: 8px; text-align: center; }
.historical-work {
  padding: 8px 10px;
  border: 1px dashed var(--sf-border);
  border-radius: var(--sf-radius-sm);
  margin-bottom: 8px;
  background: color-mix(in srgb, var(--sf-surface-alt) 50%, transparent);
}

/* ---------- Notices ---------- */
.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.notice-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.notice-close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 0;
  color: inherit;
  opacity: 0.6;
  font-size: 11px;
  cursor: pointer;
  padding: 0 2px;
  border-radius: var(--sf-radius-xs);
}
.notice-close:hover { opacity: 1; }

/* ---------- Tool head status ---------- */
.tool .head .tool-status { margin-left: auto; color: var(--vscode-charts-green); font-size: 9px; font-weight: 600; }

/* ---------- Empty state (hero + suggestions) ---------- */
.empty-state { max-width: 340px; }
.empty-hero {
  display: grid;
  place-items: center;
  width: 90px;
  height: 80px;
  position: relative;
  margin: 0 auto 18px;
}
.empty-hero .empty-icon {
  width: 56px;
  height: 56px;
  margin: 0;
  border-radius: 18px;
  transform: rotate(-8deg);
}
.empty-hero .empty-icon svg { transform: rotate(8deg); }
.empty-orbit {
  position: absolute;
  inset: 0 -2px;
  border: 1px solid color-mix(in srgb, var(--sf-accent) 30%, transparent);
  border-radius: 50%;
  transform: rotate(-26deg) scaleX(1.15);
  animation: sf-orbit 9s linear infinite;
}
.orbit-dot {
  position: absolute;
  width: 7px;
  height: 7px;
  border: 2px solid var(--vscode-editor-background);
  background: var(--sf-accent);
  border-radius: 50%;
  right: 0;
  top: 12px;
}
@keyframes sf-orbit { to { transform: rotate(334deg) scaleX(1.15); } }
.empty-eyebrow {
  color: var(--sf-muted);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  margin-bottom: 12px;
}
.empty-title {
  font-size: 17px;
  line-height: 1.25;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--vscode-foreground);
  letter-spacing: -0.3px;
}
.empty-title em { color: var(--sf-accent); font-style: normal; }
.empty-copy { margin: 0 0 16px; line-height: 1.65; }
.suggestion-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 7px;
  text-align: left;
}
.suggestion-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 11px 13px;
  background: color-mix(in srgb, var(--sf-surface-alt) 65%, transparent);
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius);
  text-align: left;
  color: var(--sf-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
}
.suggestion-card:hover {
  background: var(--sf-accent-soft);
  border-color: color-mix(in srgb, var(--sf-accent) 40%, var(--sf-border));
  transform: translateY(-2px);
}
.suggestion-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--sf-accent);
  margin-bottom: 4px;
}
.suggestion-top svg { width: 15px; height: 15px; }
.suggestion-top svg:last-child { opacity: 0.5; width: 12px; height: 12px; }
.suggestion-card strong { color: var(--vscode-foreground); font-size: 11px; font-weight: 600; }
.suggestion-card > span:last-child { font-size: 10px; line-height: 1.5; }

/* ---------- Composer hint detail ---------- */
.composer-hint small { opacity: 0.8; }

/* ---------- Reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
  .msg, .tool, .activity-card, .notice, .activity-card.leaving, .modal, .popover,
  .composer button.stop, .composer button.stop.pressed, .tool .tool-body,
  .task-panel, .task-panel-body, .thinking-dots span, .activity-spinner,
  .empty-orbit, .task-active-dot, .suggestion-card {
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
