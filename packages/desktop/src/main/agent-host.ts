// Agent host: owns the @siberflow/core Agent lifecycle and bridges its
// streaming events to the renderer via MainEvent. This is the desktop
// equivalent of the VSCode extension's ChatViewProvider (chat-panel.ts).

import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  Agent,
  buildSystemPrompt,
  createDefaultRegistry,
  createProvider,
  deleteSession,
  listSessions,
  loadSession,
  newSessionId,
  optimizeContext,
  saveOptimizedMiddleView,
  saveOptimizedView,
  saveSession,
  saveSessionSync,
  SESSION_FORMAT_VERSION,
  uploadsDirFor,
  type Provider,
  type ProviderConfig,
  type Session,
  type Task,
  type ToolRegistry,
} from "@siberflow/core";
import type {
  BannerInfo,
  CurrentSessionInfo,
  DocKind,
  HistoryEntry,
  MainEvent,
  PickedFile,
  SessionSummary,
  SettingsValues,
  UsageInfo,
} from "@shared/protocol";
import { getApiKey, setApiKey as storeApiKey, deleteApiKey, MULTIMODAL_SECRET_KEY, EXA_SECRET_KEY } from "./secrets.js";
import { loadSettings, saveSettings as persistSettings } from "./settings.js";

/** Omit system + tool messages, keeping only user/assistant content for display. */
function filterHistory(messages: Session["messages"]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant" && m.content) {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

function emptyUsage(): UsageInfo {
  return {
    last: { promptTokens: 0, completionTokens: 0, contextSize: 0 },
    total: { promptTokens: 0, completionTokens: 0 },
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
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

/**
 * Sanitize an uploaded filename for safe storage inside the project sandbox:
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

export class AgentHost {
  private provider: Provider | null = null;
  private registry: ToolRegistry | null = null;
  private agent: Agent | null = null;
  private settings: SettingsValues = loadSettings();
  private apiKey: string | null = null;
  private current: Session | null = null;
  private optSavedBytes = 0;
  private readyForChat = false;
  private turnAbort: AbortController | null = null;
  private readonly emit: (event: MainEvent) => void;
  /** Tracks whether we've emitted the initial task-plan for the current turn. */
  private planEmittedForTurn = false;

  constructor(emit: (event: MainEvent) => void) {
    this.emit = emit;
  }

  // -------- lifecycle --------

  async init(): Promise<void> {
    this.settings = loadSettings();
    this.apiKey = getApiKey(this.settings.provider);
    this.applyDebug();
    this.applyMultimodalEnv();
    this.applyExaEnv();
    if (!this.apiKey) {
      this.readyForChat = false;
      this.emit({
        type: "require-settings",
        mustConfigure: true,
        values: this.settings,
        hasApiKey: false,
        hasMultimodalApiKey: !!getApiKey(MULTIMODAL_SECRET_KEY),
        hasExaApiKey: !!getApiKey(EXA_SECRET_KEY),
      });
      return;
    }
    this.rebuildAgent();
    this.readyForChat = true;
    // On startup, resume the most recently used session if one exists, so we
    // don't spawn an empty new session every launch. Only create a fresh one
    // when there are no prior sessions at all.
    const recent = await listSessions();
    if (recent.length > 0) {
      await this.loadSessionById(recent[0]!.id);
    } else {
      this.startNewSession(null, null);
      this.postReady();
    }
    await this.broadcastSessionList();
  }

  // -------- settings --------

  getSettings(): { values: SettingsValues; hasApiKey: boolean; hasMultimodalApiKey: boolean; hasExaApiKey: boolean } {
    return {
      values: { ...this.settings },
      hasApiKey: !!this.apiKey,
      hasMultimodalApiKey: !!getApiKey(MULTIMODAL_SECRET_KEY),
      hasExaApiKey: !!getApiKey(EXA_SECRET_KEY),
    };
  }

  async openSettings(): Promise<void> {
    this.settings = loadSettings();
    this.apiKey = getApiKey(this.settings.provider);
    this.emit({
      type: "require-settings",
      mustConfigure: false,
      values: this.settings,
      hasApiKey: !!this.apiKey,
      hasMultimodalApiKey: !!getApiKey(MULTIMODAL_SECRET_KEY),
      hasExaApiKey: !!getApiKey(EXA_SECRET_KEY),
    });
  }

  saveSettings(values: SettingsValues, apiKey: string | null, multimodalApiKey: string | null, exaApiKey: string | null): void {
    values = normalizeSettings(values);
    if (values.provider === "custom" && (!values.customProvider.baseUrl || !values.customProvider.defaultModel)) {
      this.emit({ type: "error", message: "Custom provider needs a base URL and default model." });
      return;
    }
    persistSettings(values);
    this.settings = values;
    this.applyDebug();
    this.applyMultimodalEnv(multimodalApiKey);
    this.applyExaEnv(exaApiKey);

    // API key handling: null means "leave unchanged", empty means "delete".
    if (apiKey !== null) {
      if (apiKey.length > 0) {
        storeApiKey(values.provider, apiKey);
        this.apiKey = apiKey;
      } else {
        deleteApiKey(values.provider);
        this.apiKey = null;
      }
    } else {
      this.apiKey = getApiKey(values.provider);
    }

    if (!this.apiKey) {
      this.readyForChat = false;
      this.provider = null;
      this.registry = null;
      this.agent = null;
      this.emit({
        type: "require-settings",
        mustConfigure: true,
        values,
        hasApiKey: false,
        hasMultimodalApiKey: !!getApiKey(MULTIMODAL_SECRET_KEY),
        hasExaApiKey: !!getApiKey(EXA_SECRET_KEY),
      });
      this.emit({ type: "error", message: `API key for ${values.provider} required.` });
      return;
    }

    // Reflect provider/model change on the active session record.
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
      this.startNewSession(null, null);
    }
    this.postReady();
    this.emit({ type: "settings-saved", values: this.settings });
    this.emit({ type: "info", message: "Settings saved." });
  }

  // -------- agent construction --------

  private applyDebug(): void {
    if (this.settings.debug) process.env.SIBERFLOW_DEBUG = "true";
    else delete process.env.SIBERFLOW_DEBUG;
  }

  private applyMultimodalEnv(apiKeyInput: string | null = null): void {
    const baseUrl = this.settings.multimodalProvider.baseUrl.trim().replace(/\/+$/, "");
    const model = this.settings.multimodalProvider.model.trim();
    if (baseUrl) process.env.SIBERFLOW_MULTIMODAL_BASE_URL = baseUrl;
    else delete process.env.SIBERFLOW_MULTIMODAL_BASE_URL;
    if (model) process.env.SIBERFLOW_MULTIMODAL_MODEL = model;
    else delete process.env.SIBERFLOW_MULTIMODAL_MODEL;

    if (apiKeyInput !== null) {
      if (apiKeyInput.length > 0) storeApiKey(MULTIMODAL_SECRET_KEY, apiKeyInput);
      else deleteApiKey(MULTIMODAL_SECRET_KEY);
    }
    const key = getApiKey(MULTIMODAL_SECRET_KEY);
    if (key) process.env.SIBERFLOW_MULTIMODAL_API_KEY = key;
    else delete process.env.SIBERFLOW_MULTIMODAL_API_KEY;
  }

  /**
   * Web search (Exa) API key handling. The web_search tool reads
   * SIBERFLOW_EXA_API_KEY from process.env at execute time; we keep it in sync
   * with the encrypted key store. The UI disables the web_search toggle until a
   * key is stored, so the model never sees the tool without a usable credential.
   */
  private applyExaEnv(apiKeyInput: string | null = null): void {
    if (apiKeyInput !== null) {
      if (apiKeyInput.length > 0) storeApiKey(EXA_SECRET_KEY, apiKeyInput);
      else deleteApiKey(EXA_SECRET_KEY);
    }
    const key = getApiKey(EXA_SECRET_KEY);
    if (key) process.env.SIBERFLOW_EXA_API_KEY = key;
    else delete process.env.SIBERFLOW_EXA_API_KEY;
  }

  private rebuildAgent(): void {
    if (!this.apiKey) return;
    this.provider = createProvider(this.settings.provider, this.providerConfig());
    // Only register filesystem + exec tools when the session has a working
    // directory. Sessions without a workdir keep db/ssh/task tools only.
    const hasWorkdir = !!this.current?.projectDir;
    this.registry = createDefaultRegistry({
      filesystem: hasWorkdir,
      enabledTools: new Set(this.settings.enabledTools),
      provider: this.provider,
      subagent: true,
      subagentMaxIterations: this.settings.maxIterations,
    });
    this.agent = this.buildAgent();
    if (this.current) {
      this.agent.loadHistory(this.current.messages);
      if (this.current.tasks?.length) {
        this.agent.loadTasks(this.current.tasks);
      }
      // Restore the LLM compact summary (if any) so "compact" mode keeps
      // rolling it forward instead of restarting from scratch on resume.
      this.agent.loadSummary(this.current.summary ?? null);
    }
  }

  private buildAgent(): Agent {
    if (!this.provider || !this.registry) throw new Error("provider not ready");
    const modelOverride = this.settings.model.trim();
    const model = modelOverride.length > 0 ? modelOverride : this.provider.defaultModel;
    const systemPrompt = buildSystemPrompt({
      interface: "vscode",
      summaryMode: this.summaryModeActive(),
      enabledToolNames: this.registry.list().map((t) => t.name),
    });
    const workdir = this.current?.projectDir;
    // uploadDir is the per-session tmp dir where uploaded Excels live. Pass it
    // so excel_script can whitelist reads from there even though it's outside
    // the project sandbox.
    const uploadDir = this.current ? uploadsDirFor(this.current.id) : undefined;
    return new Agent({
      provider: this.provider,
      registry: this.registry,
      model,
      systemPrompt,
      // projectDir is optional now — pass undefined when no workdir so the
      // agent won't sandbox to a random cwd.
      ...(workdir ? { projectDir: workdir } : {}),
      ...(uploadDir ? { uploadDir } : {}),
      askUser: (req) => this.askUserViaRenderer(req),
      contextOptimize: this.optimizeConfig(),
      tasksEnabled: true,
      autoContinue: this.settings.autoContinue,
      preTruncate: this.settings.preTruncate,
      maxIterations: this.settings.maxIterations,
      requestDelayMs: this.settings.requestDelayMs,
      // Seed the compact-mode threshold trigger with the resumed session's
      // last prompt size (contextSize = last iteration's prompt, accurate
      // context window — not the turn-accumulated promptTokens).
      ...(this.current?.usage?.last?.contextSize
        ? { lastPromptTokens: this.current.usage.last.contextSize }
        : {}),
    });
  }

  /**
   * Pending ask_user prompts keyed by id. Each entry holds the resolve/reject
   * pair for the promise the tool is awaiting on. Cleared when the renderer
   * posts back via resolveUserAnswer.
   */
  private pendingUserQuestions = new Map<
    string,
    { resolve: (resp: { status: "answer" | "cancel"; answer: string }) => void }
  >();

  /** Emit an ask_user event to the renderer and await its response. */
  private askUserViaRenderer(req: {
    question: string;
    choices?: string[];
    allowFreeText?: boolean;
    defaultChoice?: string;
  }): Promise<{ status: "answer" | "cancel"; answer: string }> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      this.pendingUserQuestions.set(id, { resolve });
      this.emit({
        type: "ask-user",
        id,
        question: req.question,
        choices: req.choices ?? [],
        allowFreeText: req.allowFreeText ?? false,
        ...(req.defaultChoice ? { defaultChoice: req.defaultChoice } : {}),
      });
    });
  }

  /** Called from the IPC handler when the renderer posts the user's answer. */
  resolveUserAnswer(id: string, status: "answer" | "cancel", answer: string): void {
    const entry = this.pendingUserQuestions.get(id);
    if (!entry) return;
    this.pendingUserQuestions.delete(id);
    entry.resolve({ status, answer });
  }

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

  // -------- session management --------

  startNewSession(folderPath: string | null, name: string | null): CurrentSessionInfo {
    if (!this.provider) throw new Error("provider not ready");
    // Inherit the workdir from the previous session when the caller didn't
    // specify one (folderPath === null). This keeps the common single-project
    // workflow frictionless: New chat reuses the folder the user already
    // picked, instead of forcing them to pick it again. An explicit "" from
    // the caller means "start empty".
    const inheritedWorkdir = folderPath === null ? (this.current?.projectDir || null) : folderPath;
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
      projectDir: inheritedWorkdir ?? "",
      provider: this.provider.name,
      model,
      createdAt: now,
      updatedAt: now,
      messages: [...this.agent.history()],
      usage: { last: { promptTokens: 0, completionTokens: 0 }, total: { promptTokens: 0, completionTokens: 0 } },
    };
    // Rebuild so the agent's projectDir + tool set matches the new session.
    this.rebuildAgent();
    saveSessionSync(this.current);
    this.writeOptimizedView();
    // Notify the renderer so the new session becomes active immediately in the
    // main container (clears history, sets the session, refreshes the sidebar).
    this.postReady();
    void this.broadcastSessionList();
    return this.sessionInfo()!;
  }

  async loadSessionById(id: string): Promise<void> {
    const session = await loadSession(id);
    if (!session) {
      this.emit({ type: "error", message: "Session not found." });
      return;
    }
    this.current = session;
    this.rebuildAgent();
    this.postReady();
  }

  /** Set or change the working directory for the current session. Empty string
   * clears it (disables filesystem + exec tools). */
  setWorkdir(folderPath: string): void {
    if (!this.current) return;
    this.current.projectDir = folderPath;
    this.current.updatedAt = new Date().toISOString();
    saveSessionSync(this.current);
    // Rebuild the agent so the tool set + sandbox reflect the new workdir.
    this.rebuildAgent();
    this.postReady();
    void this.broadcastSessionList();
  }

  /** The current session's working directory, or null when there is none. */
  getWorkdir(): string | null {
    return this.current?.projectDir || null;
  }

  /**
   * Copy a list of source file paths into the session's per-session upload dir
   * in the OS tmp folder (NOT the project dir — keeps the workspace clean and
   * out of git). Filenames are sanitized; collisions are de-duplicated with a
   * short suffix. Accepted: `.xlsx`, `.docx`, `.pdf`. Returns metadata with the
   * absolute destination path + `kind` (derived from extension) so the renderer
   * can pick the right chip icon and the prompt builder can name the matching
   * tool (`excel_script` / `docx_script` / `pdf_script`), which whitelists this
   * dir via the agent's `uploadDir` option. The folder is removed automatically
   * when the session is deleted.
   */
  async copyUploads(srcPaths: string[]): Promise<PickedFile[]> {
    if (!this.current) {
      throw new Error("Tidak ada session aktif.");
    }
    const destDir = uploadsDirFor(this.current.id);
    // mode 0o700: owner-only, so other users on a shared Linux box can't read
    // uploaded docs out of /tmp.
    await mkdir(destDir, { recursive: true, mode: 0o700 });

    const usedNames = new Set<string>();
    const out: PickedFile[] = [];
    for (const src of srcPaths) {
      const original = basename(src);
      const lower = original.toLowerCase();
      let kind: DocKind;
      if (lower.endsWith(".xlsx")) kind = "excel";
      else if (lower.endsWith(".docx")) kind = "docx";
      else if (lower.endsWith(".pdf")) kind = "pdf";
      else throw new Error(`File "${original}" bukan .xlsx/.docx/.pdf. Hanya dokumen yang didukung.`);
      const safe = sanitizeFileName(original, usedNames);
      usedNames.add(safe);
      const dest = join(destDir, safe);
      await copyFile(src, dest);
      const stats = await stat(dest);
      // relPath is the ABSOLUTE tmp path — the *_script tools resolve absolute
      // paths against the upload dir whitelist. (Field name kept for protocol
      // stability; semantically it's an absolute path now.)
      out.push({ name: original, kind, relPath: dest, bytes: stats.size });
    }
    return out;
  }

  async deleteSessionById(id: string): Promise<void> {
    await deleteSession(id);
    if (this.current?.id === id) {
      // Active session deleted — clear state so the renderer shows the empty
      // welcome screen instead of the now-orphaned messages/composer.
      this.current = null;
      this.agent = null;
      this.emit({ type: "session-changed", session: null });
    }
    await this.broadcastSessionList();
  }

  async renameSession(id: string, name: string): Promise<void> {
    if (!this.current || this.current.id !== id) return;
    this.current.name = name.trim().length > 0 ? name.trim() : null;
    this.current.updatedAt = new Date().toISOString();
    saveSessionSync(this.current);
    this.emit({ type: "session-changed", session: this.sessionInfo() });
  }

  async listSessions(projectDir?: string): Promise<SessionSummary[]> {
    return listSessions(projectDir ? { projectDir } : undefined);
  }

  async broadcastSessionList(): Promise<void> {
    const sessions = await this.listSessions();
    this.emit({ type: "session-list", sessions });
  }

  getUsage(): UsageInfo | null {
    if (!this.current) return null;
    return this.current.usage;
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
        this.emit({ type: "session-changed", session: this.sessionInfo() });
      }
    }
    return this.runTurn(input);
  }

  async regenerate(): Promise<void> {
    if (this.turnAbort) {
      this.emit({ type: "info", message: "A turn is already running." });
      return;
    }
    if (!this.agent) {
      this.emit({ type: "error", message: "Configure settings first." });
      this.emit({ type: "assistant-end" });
      return;
    }
    const last = this.agent.rewindToLastUserMessage();
    if (last === null) {
      this.emit({ type: "info", message: "Nothing to regenerate." });
      this.emit({ type: "assistant-end" });
      return;
    }
    await this.runTurn(last);
  }

  async editLast(input: string): Promise<void> {
    if (this.turnAbort) {
      this.emit({ type: "info", message: "A turn is already running." });
      return;
    }
    if (!this.agent) {
      this.emit({ type: "error", message: "Configure settings first." });
      this.emit({ type: "assistant-end" });
      return;
    }
    const last = this.agent.rewindToLastUserMessage();
    if (last === null) {
      this.emit({ type: "info", message: "Nothing to edit." });
      this.emit({ type: "assistant-end" });
      return;
    }
    await this.runTurn(input);
  }

  stop(): void {
    this.turnAbort?.abort();
  }

  private async runTurn(input: string): Promise<void> {
    if (this.turnAbort) {
      this.emit({ type: "info", message: "A turn is already running." });
      return;
    }
    if (!this.agent) {
      this.emit({ type: "error", message: "Configure settings first." });
      this.emit({ type: "assistant-end" });
      return;
    }
    const abort = new AbortController();
    this.turnAbort = abort;
    this.planEmittedForTurn = false;
    const initialTaskCount = this.agent.getTasks().length;
    let turnAddPrompt = 0;
    let turnAddCompletion = 0;
    // Track the LAST iteration's prompt size so usage.last.contextSize
    // reflects the actual context the model saw (not the turn accumulation).
    let lastIterPrompt = 0;

    try {
      await this.agent.send(input, {
        signal: abort.signal,
        onAssistantStart: () => this.emit({ type: "assistant-start" }),
        onContent: (delta) => this.emit({ type: "assistant-content", delta }),
        onAssistantEnd: (_msg, meta) => {
          if (meta.usage) {
            turnAddPrompt += meta.usage.promptTokens;
            turnAddCompletion += meta.usage.completionTokens;
            lastIterPrompt = meta.usage.promptTokens;
          }
          // Close the current iteration so the next one opens a fresh bubble.
          this.emit({ type: "iteration-end" });
        },
        onToolCallStart: (index, name) =>
          this.emit({ type: "tool-call-start", index, name }),
        onToolCallArgs: (index, delta) =>
          this.emit({ type: "tool-call-args", index, delta }),
        onToolResult: (index, name, result) =>
          this.emit({ type: "tool-result", index, name, result }),
        onTasksUpdated: (tasks) => {
          const taskList = tasks as Task[];
          // Emit task-plan once per turn when tasks are first populated.
          if (!this.planEmittedForTurn && initialTaskCount === 0 && taskList.length > 0) {
            this.planEmittedForTurn = true;
            this.emit({ type: "task-plan", tasks: taskList });
          }
          this.emit({ type: "tasks", tasks: taskList });
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
          this.emit({ type: "context-optimized", bytesSaved: stats.bytesSaved });
        },
        onContextCompacting: () => this.emit({ type: "context-compacting" }),
        onContextCompacted: (stats) =>
          this.emit({
            type: "context-compacted",
            turnsSummarized: stats.turnsSummarized,
            summaryChars: stats.summaryChars,
          }),
        onSubagentUpdate: (phase, detail) =>
          this.emit({ type: "subagent-update", phase, detail }),
        onMaxIterations: (limit) =>
          this.emit({ type: "max-iterations", limit }),
      });

      if (this.current) {
        // usage.last.promptTokens = AKUMULASI seluruh iterasi pada turn terakhir
        // (semua tool loops digabung) — info billing. contextSize = prompt size
        // iterasi TERAKHIR — itu context window asli yg dilihat model, dipakai
        // context bar & compact threshold saat resume.
        this.current.usage.last = {
          promptTokens: turnAddPrompt,
          completionTokens: turnAddCompletion,
          contextSize: lastIterPrompt,
        };
        this.current.usage.total.promptTokens += turnAddPrompt;
        this.current.usage.total.completionTokens += turnAddCompletion;
      }
      await this.persistAfterTurn();
    } catch (err) {
      if (isAbortError(err)) {
        if (this.agent) this.emit({ type: "tasks", tasks: this.agent.getTasks() as Task[] });
        this.emit({ type: "info", message: "generation stopped" });
      } else {
        this.emit({ type: "error", message: (err as Error).message });
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
      this.emit({ type: "assistant-end" });
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
      tasks: [...this.agent.getTasks()],
      ...(this.agent.summaryState()
        ? { summary: this.agent.summaryState()! }
        : {}),
    };
    await saveSession(session);
    this.current = session;
    this.writeOptimizedView();
    this.emit({ type: "session-changed", session: this.sessionInfo() });
    this.emitUsage();
  }

  private writeOptimizedView(): void {
    if (!this.current || !this.settings.contextOptimize) return;
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

  // -------- helpers --------

  private banner(): BannerInfo {
    return {
      provider: this.provider?.name ?? displayProviderName(this.settings),
      model:
        this.settings.model.trim().length > 0
          ? this.settings.model.trim()
          : this.provider?.defaultModel ?? "?",
    };
  }

  private providerConfig(settings: SettingsValues = this.settings): ProviderConfig {
    if (!this.apiKey) {
      throw new Error("API key is not configured.");
    }
    if (settings.provider !== "custom") {
      return { apiKey: this.apiKey };
    }
    return {
      apiKey: this.apiKey,
      baseUrl: settings.customProvider.baseUrl,
      customName: settings.customProvider.name,
      customDefaultModel: settings.customProvider.defaultModel,
    };
  }

  private sessionInfo(): CurrentSessionInfo | null {
    if (!this.current) return null;
    return {
      id: this.current.id,
      name: this.current.name,
      projectDir: this.current.projectDir,
    };
  }

  private postReady(): void {
    this.emit({
      type: "ready",
      banner: this.banner(),
      session: this.sessionInfo(),
      hideTools: this.settings.hideTools,
      tasksEnabled: true,
      enabledTools: this.settings.enabledTools,
      values: this.settings,
    });
    if (this.current && this.current.messages.length > 0) {
      this.emit({ type: "history", messages: filterHistory(this.current.messages) });
    }
    if (this.agent) {
      this.emit({ type: "tasks", tasks: this.agent.getTasks() as Task[] });
    }
    this.emitUsage();
  }

  /** Emit the current usage stats so the renderer can show context size. */
  private emitUsage(): void {
    const usage = this.getUsage();
    if (usage) this.emit({ type: "usage", usage });
  }
}

function displayProviderName(settings: SettingsValues): string {
  return settings.provider === "custom"
    ? settings.customProvider.name || "custom"
    : settings.provider;
}

function normalizeSettings(values: SettingsValues): SettingsValues {
  const customProvider = values.customProvider ?? { name: "custom", baseUrl: "", defaultModel: "" };
  const multimodalProvider = values.multimodalProvider ?? { baseUrl: "https://api.openai.com/v1", model: "" };
  return {
    ...values,
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
