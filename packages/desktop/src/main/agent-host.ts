// Agent host: owns the @siberflow/core Agent lifecycle and bridges its
// streaming events to the renderer via MainEvent. This is the desktop
// equivalent of the VSCode extension's ChatViewProvider (chat-panel.ts).

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
  type Provider,
  type Session,
  type Task,
  type ToolRegistry,
} from "@siberflow/core";
import type {
  BannerInfo,
  CurrentSessionInfo,
  HistoryEntry,
  MainEvent,
  SessionSummary,
  SettingsValues,
  UsageInfo,
} from "@shared/protocol";
import { getApiKey, setApiKey as storeApiKey, deleteApiKey } from "./secrets.js";
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
    last: { promptTokens: 0, completionTokens: 0 },
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
    if (!this.apiKey) {
      this.readyForChat = false;
      this.emit({
        type: "require-settings",
        mustConfigure: true,
        values: this.settings,
        hasApiKey: false,
      });
      return;
    }
    this.rebuildAgent();
    this.readyForChat = true;
    this.startNewSession(null, null);
    this.postReady();
  }

  // -------- settings --------

  getSettings(): { values: SettingsValues; hasApiKey: boolean } {
    return { values: { ...this.settings }, hasApiKey: !!this.apiKey };
  }

  async openSettings(): Promise<void> {
    this.settings = loadSettings();
    this.apiKey = getApiKey(this.settings.provider);
    this.emit({
      type: "require-settings",
      mustConfigure: false,
      values: this.settings,
      hasApiKey: !!this.apiKey,
    });
  }

  saveSettings(values: SettingsValues, apiKey: string | null): void {
    persistSettings(values);
    this.settings = values;
    this.applyDebug();

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
      });
      this.emit({ type: "error", message: `API key for ${values.provider} required.` });
      return;
    }

    // Reflect provider/model change on the active session record.
    if (this.current) {
      this.current.provider = values.provider;
      this.current.model =
        values.model.trim().length > 0
          ? values.model.trim()
          : createProvider(values.provider, { apiKey: this.apiKey }).defaultModel;
      this.current.updatedAt = new Date().toISOString();
      if (!values.tasks) delete this.current.tasks;
      saveSessionSync(this.current);
    }

    this.rebuildAgent();
    if (!this.readyForChat) {
      this.readyForChat = true;
      this.startNewSession(null, null);
    }
    this.postReady();
    this.emit({ type: "settings-saved" });
    this.emit({ type: "info", message: "Settings saved." });
  }

  // -------- agent construction --------

  private applyDebug(): void {
    if (this.settings.debug) process.env.SIBERFLOW_DEBUG = "true";
    else delete process.env.SIBERFLOW_DEBUG;
  }

  private rebuildAgent(): void {
    if (!this.apiKey) return;
    this.provider = createProvider(this.settings.provider, { apiKey: this.apiKey });
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
    const model = modelOverride.length > 0 ? modelOverride : this.provider.defaultModel;
    const systemPrompt = buildSystemPrompt({
      interface: "vscode",
      tasksEnabled: this.settings.tasks,
      summaryMode: this.summaryModeActive(),
    });
    return new Agent({
      provider: this.provider,
      registry: this.registry,
      model,
      systemPrompt,
      projectDir: this.current?.projectDir ?? process.cwd(),
      contextOptimize: this.optimizeConfig(),
      tasksEnabled: this.settings.tasks,
      autoContinue: this.settings.autoContinue,
      maxIterations: this.settings.maxIterations,
    });
  }

  private summaryModeActive(): boolean {
    return (
      this.settings.contextOptimize && this.settings.contextOptimizeMode === "summary"
    );
  }

  private optimizeConfig(): { enabled: boolean; mode?: "drop" | "summary" } {
    return {
      enabled: this.settings.contextOptimize,
      ...(this.settings.contextOptimizeMode !== "summary"
        ? { mode: this.settings.contextOptimizeMode }
        : {}),
    };
  }

  // -------- session management --------

  startNewSession(folderPath: string | null, name: string | null): CurrentSessionInfo {
    if (!this.provider) throw new Error("provider not ready");
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
      projectDir: folderPath ?? process.cwd(),
      provider: this.provider.name,
      model,
      createdAt: now,
      updatedAt: now,
      messages: [...this.agent.history()],
      usage: { last: { promptTokens: 0, completionTokens: 0 }, total: { promptTokens: 0, completionTokens: 0 } },
    };
    // Rebuild so the agent's projectDir matches the new session's folder.
    this.agent = this.buildAgent();
    saveSessionSync(this.current);
    this.writeOptimizedView();
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

  async deleteSessionById(id: string): Promise<void> {
    await deleteSession(id);
    if (this.current?.id === id) {
      this.current = null;
      this.agent = null;
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
    let latestUsage: UsageInfo["last"] | undefined;
    let turnAddPrompt = 0;
    let turnAddCompletion = 0;

    try {
      await this.agent.send(input, {
        signal: abort.signal,
        onAssistantStart: () => this.emit({ type: "assistant-start" }),
        onContent: (delta) => this.emit({ type: "assistant-content", delta }),
        onAssistantEnd: (_msg, meta) => {
          if (meta.usage) {
            latestUsage = meta.usage;
            turnAddPrompt += meta.usage.promptTokens;
            turnAddCompletion += meta.usage.completionTokens;
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
        onMaxIterations: (limit) =>
          this.emit({ type: "max-iterations", limit }),
      });

      if (this.current && latestUsage) {
        this.current.usage.last = latestUsage;
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
      ...(this.settings.tasks ? { tasks: [...this.agent.getTasks()] } : {}),
    };
    if (!this.settings.tasks) delete session.tasks;
    await saveSession(session);
    this.current = session;
    this.writeOptimizedView();
    this.emit({ type: "session-changed", session: this.sessionInfo() });
  }

  private writeOptimizedView(): void {
    if (!this.current || !this.settings.contextOptimize) return;
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

  // -------- helpers --------

  private banner(): BannerInfo {
    return {
      provider: this.settings.provider,
      model:
        this.settings.model.trim().length > 0
          ? this.settings.model.trim()
          : this.provider?.defaultModel ?? "?",
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
      tasksEnabled: this.settings.tasks,
    });
    if (this.current && this.current.messages.length > 0) {
      this.emit({ type: "history", messages: filterHistory(this.current.messages) });
    }
    if (this.settings.tasks && this.agent) {
      this.emit({ type: "tasks", tasks: this.agent.getTasks() as Task[] });
    }
  }
}
