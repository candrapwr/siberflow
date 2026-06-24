import type { SessionUsage, Task } from "@siberflow/core";

/** Messages from extension host → webview. */
export type ExtToView =
  | { kind: "ready"; banner: BannerInfo; session: SessionInfo | null; hideTools: boolean; tasksEnabled: boolean; enabledTools: string[] }
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
  | { kind: "history"; messages: HistoryMessage[] }
  | { kind: "excel_files_picked"; files: PickedFile[] }
  | { kind: "excel_pick_error"; message: string }
  | { kind: "ask_user"; id: string; question: string; choices: string[]; allowFreeText: boolean; defaultChoice?: string };

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * An uploaded Excel file after it has been copied into the per-session upload
 * dir (OS tmp, NOT the workspace folder). `read_excel` whitelists this
 * location via the agent's `uploadDir` option.
 */
export interface PickedFile {
  /** Display name (original filename). */
  name: string;
  /**
   * Absolute path to the copied file in the OS tmp dir. Despite the field
   * name (kept for protocol stability), this is an absolute path, not
   * workspace-relative.
   */
  relPath: string;
}

/** Messages from webview → extension host. */
export type ViewToExt =
  | { kind: "init" }
  | { kind: "send"; input: string }
  | { kind: "stop" }
  | { kind: "regenerate" }
  | { kind: "edit_last"; input: string }
  | { kind: "command"; command: "new" | "load" | "delete" | "clearAll" | "usage" | "tools" | "settings" }
  | { kind: "save_settings"; values: SettingsValues; apiKey: string | null }
  | { kind: "pick_excel_files" }
  | { kind: "answer_user"; id: string; status: "answer" | "cancel"; answer: string };

export type ProviderName = "deepseek" | "gemini" | "openai" | "openai-responses" | "grok" | "qwen" | "zai" | "claude";

export type OptimizeMode = "drop" | "summary";

export interface SettingsValues {
  provider: ProviderName;
  model: string;
  contextOptimize: boolean;
  contextOptimizeMode: OptimizeMode;
  autoContinue: boolean;
  hideTools: boolean;
  debug: boolean;
  maxIterations: number;
  /** Milliseconds to wait before each LLM request (anti rate-limit). 0 = off. */
  requestDelayMs: number;
  /** Tool names enabled for the agent. Default: file ops only. */
  enabledTools: string[];
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
