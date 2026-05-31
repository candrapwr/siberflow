import type { SessionUsage, Task } from "@siberflow/core";

/** Messages from extension host → webview. */
export type ExtToView =
  | { kind: "ready"; banner: BannerInfo; session: SessionInfo | null; hideTools: boolean; tasksEnabled: boolean }
  | { kind: "assistant_start" }
  | { kind: "assistant_content"; delta: string }
  | { kind: "iteration_end" }
  | { kind: "assistant_end" }
  | { kind: "tool_call_start"; index: number; name: string }
  | { kind: "tool_call_args"; index: number; delta: string }
  | { kind: "tool_result"; index: number; name: string; result: string }
  | { kind: "tasks"; tasks: Task[] }
  | { kind: "context_optimized"; bytesSaved: number }
  | { kind: "max_iterations"; limit: number }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string }
  | { kind: "session_changed"; session: SessionInfo | null }
  | { kind: "usage"; usage: SessionUsage; optSaved: number }
  | { kind: "settings"; values: SettingsValues; hasApiKey: boolean; mustConfigure: boolean }
  | { kind: "history"; messages: HistoryMessage[] };

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** Messages from webview → extension host. */
export type ViewToExt =
  | { kind: "init" }
  | { kind: "send"; input: string }
  | { kind: "command"; command: "new" | "load" | "delete" | "clearAll" | "usage" | "tools" | "settings" }
  | { kind: "save_settings"; values: SettingsValues; apiKey: string | null };

export type ProviderName = "deepseek" | "gemini" | "openai" | "openai-responses";

export interface SettingsValues {
  provider: ProviderName;
  model: string;
  tasks: boolean;
  contextOptimize: boolean;
  autoContinue: boolean;
  hideTools: boolean;
  debug: boolean;
  maxIterations: number;
}

export interface BannerInfo {
  version: string;
  provider: string;
  model: string;
  projectDir: string;
}

export interface SessionInfo {
  id: string;
  name: string | null;
  messageCount: number;
}
