// Shared types between the Electron main process, preload bridge, and the
// React renderer. Imported via the "@shared/*" alias (see tsconfig).

import type { Task } from "@siberflow/core";
import type { Message } from "@siberflow/core";

/** All supported LLM provider names (mirrors core's ProviderName). */
export type ProviderName =
  | "deepseek"
  | "gemini"
  | "openai"
  | "openai-responses"
  | "grok"
  | "qwen"
  | "zai"
  | "claude"
  | "custom";

export interface CustomProviderSettings {
  name: string;
  baseUrl: string;
  defaultModel: string;
}

export interface MultimodalProviderSettings {
  baseUrl: string;
  model: string;
}

/** Persisted settings shape (stored in userData/siberflow-settings.json). */
export interface SettingsValues {
  provider: ProviderName;
  customProvider: CustomProviderSettings;
  multimodalProvider: MultimodalProviderSettings;
  model: string;
  contextOptimize: boolean;
  contextOptimizeMode: "drop" | "summary" | "recent" | "compact";
  /** Compact-mode: max prompt tokens (context window budget). Default 200000. */
  contextWindow: number;
  /** Compact-mode: ratio (0..1) triggering summarization. Default 0.8. */
  compactThreshold: number;
  /** Compact-mode: recent completed turns kept verbatim. Default 2. */
  compactKeepRecent: number;
  autoContinue: boolean;
  /** Pre-truncate large tool outputs/arguments (read_file 200 lines, exec 20K chars,
   * write_file/edit_file arg digest). Default true. */
  preTruncate: boolean;
  hideTools: boolean;
  debug: boolean;
  maxIterations: number;
  /** Milliseconds to wait before each LLM request (anti rate-limit). 0 = off. */
  requestDelayMs: number;
  /** Tool names enabled for the agent. Default: file ops only. */
  enabledTools: string[];
}

export const DEFAULT_SETTINGS: SettingsValues = {
  provider: "deepseek",
  customProvider: {
    name: "custom",
    baseUrl: "",
    defaultModel: "",
  },
  multimodalProvider: {
    baseUrl: "https://api.openai.com/v1",
    model: "",
  },
  model: "",
  contextOptimize: true,
  contextOptimizeMode: "compact",
  contextWindow: 200000,
  compactThreshold: 0.8,
  compactKeepRecent: 2,
  autoContinue: true,
  preTruncate: true,
  hideTools: true,
  debug: false,
  maxIterations: 50,
  requestDelayMs: 1500,
  enabledTools: ["read_file", "write_file", "edit_file", "copy_file", "list_dir", "delete_file", "grep"],
};

/** Info shown in the topbar / sidebar. */
export interface BannerInfo {
  provider: string;
  model: string;
}

/** A session summary entry in the sidebar list. */
export interface SessionSummary {
  id: string;
  name: string | null;
  projectDir: string;
  updatedAt: string;
  messageCount: number;
}

/** Current active session metadata sent to the renderer. */
export interface CurrentSessionInfo {
  id: string;
  name: string | null;
  projectDir: string;
}

/** Usage stats shown in the usage view. */
export interface UsageInfo {
  last: { promptTokens: number; completionTokens: number; contextSize?: number };
  total: { promptTokens: number; completionTokens: number };
}

/** A rendered history message for initial load. */
export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

/**
 * An uploaded document file after it has been copied into the per-session upload
 * dir (OS tmp, NOT the project dir). `excel_script` / `docx_script` /
 * `pdf_script` whitelists this location via the agent's `uploadDir` option.
 */
export type DocKind = "excel" | "docx" | "pdf";

export interface PickedFile {
  /** Display name (original filename). */
  name: string;
  /** Document kind, derived from extension — drives chip icon + prompt tool. */
  kind: DocKind;
  /**
   * Absolute path to the copied file in the OS tmp dir. Despite the field
   * name (kept for protocol stability), this is an absolute path, not
   * project-relative.
   */
  relPath: string;
  /** File size in bytes. */
  bytes: number;
}

// ---- Main → Renderer (streaming events) ----

export type MainEvent =
  | { type: "ready"; banner: BannerInfo; session: CurrentSessionInfo | null; hideTools: boolean; tasksEnabled: boolean; enabledTools: string[]; values: SettingsValues }
  | { type: "require-settings"; mustConfigure: boolean; values: SettingsValues; hasApiKey: boolean; hasMultimodalApiKey: boolean; hasExaApiKey: boolean }
  | { type: "settings-saved"; values: SettingsValues }
  | { type: "session-changed"; session: CurrentSessionInfo | null }
  | { type: "session-list"; sessions: SessionSummary[] }
  | { type: "history"; messages: HistoryEntry[] }
  | { type: "assistant-start" }
  | { type: "assistant-content"; delta: string }
  | { type: "iteration-end" }
  | { type: "assistant-end" }
  | { type: "tool-call-start"; index: number; name: string }
  | { type: "tool-call-args"; index: number; delta: string }
  | { type: "tool-result"; index: number; name: string; result: string }
  | { type: "task-plan"; tasks: Task[] }
  | { type: "tasks"; tasks: Task[] }
  | { type: "context-optimized"; bytesSaved: number }
  | { type: "context-compacting" }
  | { type: "context-compacted"; turnsSummarized: number; summaryChars: number }
  | { type: "subagent-update"; phase: string; detail?: string }
  | { type: "max-iterations"; limit: number }
  | { type: "usage"; usage: UsageInfo }
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "ask-user"; id: string; question: string; choices: string[]; allowFreeText: boolean; defaultChoice?: string };

// ---- Renderer → Main (invoked calls) ----

export interface RendererCalls {
  init: () => Promise<void>;
  send: (input: string) => Promise<void>;
  stop: () => Promise<void>;
  regenerate: () => Promise<void>;
  editLast: (input: string) => Promise<void>;
  newSession: (folderPath: string | null, name: string | null) => Promise<CurrentSessionInfo>;
  loadSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  listSessions: (projectDir?: string) => Promise<SessionSummary[]>;
  pickFolder: () => Promise<string | null>;
  setWorkdir: (folderPath: string) => Promise<void>;
  /**
   * Open a native multi-select file picker filtered to .xlsx/.docx/.pdf, copy
   * each chosen file into the current session's upload sandbox dir, and return
   * the copied file metadata (with `kind` per file). Returns `{ error }` if the
   * session has no workdir or the copy failed; `{ files: [] }` if cancelled.
   */
  pickDocFiles: () => Promise<{ files: PickedFile[] } | { error: string }>;
  /**
   * Respond to an ask_user prompt. `status` is "answer" (user picked/typed)
   * or "cancel" (user dismissed). Resolves once the host has unblocked the
   * awaiting tool.
   */
  answerUser: (id: string, status: "answer" | "cancel", answer: string) => Promise<void>;
  getSettings: () => Promise<{ values: SettingsValues; hasApiKey: boolean; hasMultimodalApiKey: boolean; hasExaApiKey: boolean }>;
  saveSettings: (values: SettingsValues, apiKey: string | null, multimodalApiKey: string | null, exaApiKey: string | null) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  getUsage: () => Promise<UsageInfo | null>;
  onEvent: (callback: (event: MainEvent) => void) => () => void;
}
