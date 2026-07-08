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
  | { kind: "tool_batch_start"; count: number }
  | { kind: "tool_batch_end" }
  | { kind: "tasks"; tasks: Task[] }
  | { kind: "context_optimized"; bytesSaved: number }
  | { kind: "context_compacting" }
  | { kind: "context_compacted"; turnsSummarized: number; summaryChars: number }
  | { kind: "subagent_update"; phase: string; detail?: string }
  | { kind: "max_iterations"; limit: number }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string }
  | { kind: "session_changed"; session: SessionInfo | null }
  | { kind: "usage"; usage: SessionUsage; optSaved: number }
  | { kind: "settings"; values: SettingsValues; hasApiKey: boolean; hasMultimodalApiKey: boolean; hasExaApiKey: boolean; mustConfigure: boolean }
  | { kind: "history"; messages: HistoryMessage[] }
  | { kind: "doc_files_picked"; files: PickedFile[] }
  | { kind: "doc_pick_error"; message: string }
  | { kind: "ask_user"; id: string; question: string; choices: string[]; allowFreeText: boolean; defaultChoice?: string };

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * An uploaded document after it has been copied into the per-session upload
 * dir (OS tmp, NOT the workspace folder). The `*_script` tools (excel/docx/pdf)
 * whitelist this location via the agent's `uploadDir` option.
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
  | { kind: "save_settings"; values: SettingsValues; apiKey: string | null; multimodalApiKey: string | null; exaApiKey: string | null }
  | { kind: "pick_doc_files" }
  | { kind: "answer_user"; id: string; status: "answer" | "cancel"; answer: string };

export type ProviderName = "deepseek" | "gemini" | "openai" | "openai-responses" | "grok" | "qwen" | "zai" | "claude" | "custom";

export interface CustomProviderSettings {
  name: string;
  baseUrl: string;
  defaultModel: string;
}

export interface MultimodalProviderSettings {
  baseUrl: string;
  model: string;
}

export type OptimizeMode = "drop" | "summary" | "recent" | "compact";

export interface SettingsValues {
  provider: ProviderName;
  customProvider: CustomProviderSettings;
  multimodalProvider: MultimodalProviderSettings;
  model: string;
  contextOptimize: boolean;
  contextOptimizeMode: OptimizeMode;
  /** Compact-mode: max prompt tokens (context window budget). Default 200000. */
  contextWindow: number;
  /** Compact-mode: ratio (0..1) triggering summarization. Default 0.8. */
  compactThreshold: number;
  /** Compact-mode: recent completed turns kept verbatim. Default 2. */
  compactKeepRecent: number;
  autoContinue: boolean;
  /** Pre-truncate large tool outputs/arguments. Default true. */
  preTruncate: boolean;
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
