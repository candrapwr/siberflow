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
  | "claude";

/** Persisted settings shape (stored in userData/siberflow-settings.json). */
export interface SettingsValues {
  provider: ProviderName;
  model: string;
  tasks: boolean;
  contextOptimize: boolean;
  contextOptimizeMode: "drop" | "summary";
  autoContinue: boolean;
  hideTools: boolean;
  debug: boolean;
  maxIterations: number;
}

export const DEFAULT_SETTINGS: SettingsValues = {
  provider: "deepseek",
  model: "",
  tasks: true,
  contextOptimize: true,
  contextOptimizeMode: "summary",
  autoContinue: true,
  hideTools: true,
  debug: false,
  maxIterations: 50,
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
  last: { promptTokens: number; completionTokens: number };
  total: { promptTokens: number; completionTokens: number };
}

/** A rendered history message for initial load. */
export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

// ---- Main → Renderer (streaming events) ----

export type MainEvent =
  | { type: "ready"; banner: BannerInfo; session: CurrentSessionInfo | null; hideTools: boolean; tasksEnabled: boolean }
  | { type: "require-settings"; mustConfigure: boolean; values: SettingsValues; hasApiKey: boolean }
  | { type: "settings-saved" }
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
  | { type: "max-iterations"; limit: number }
  | { type: "usage"; usage: UsageInfo }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

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
  getSettings: () => Promise<{ values: SettingsValues; hasApiKey: boolean }>;
  saveSettings: (values: SettingsValues, apiKey: string | null) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  getUsage: () => Promise<UsageInfo | null>;
  onEvent: (callback: (event: MainEvent) => void) => () => void;
}
