import type { SessionUsage, Task } from "@siberflow/core";

/** Messages from extension host → webview. */
export type ExtToView =
  | { kind: "ready"; banner: BannerInfo; session: SessionInfo | null; hideTools: boolean; tasksEnabled: boolean; enabledTools: string[]; values: SettingsValues }
  | { kind: "assistant_start" }
  | { kind: "assistant_content"; delta: string }
  /** One streamed reasoning/thinking delta; webview shows a live word counter. */
  | { kind: "reasoning"; delta: string }
  | { kind: "iteration_end" }
  | { kind: "assistant_end" }
  | { kind: "tool_round_end" }
  | { kind: "tool_call_start"; index: number; name: string }
  | { kind: "tool_call_args"; index: number; delta: string }
  | { kind: "tool_result"; index: number; name: string; result: string }
  | { kind: "tool_batch_start"; count: number }
  | { kind: "tool_batch_end" }
  | { kind: "task_plan"; tasks: Task[] }
  | { kind: "tasks"; tasks: Task[]; restored?: boolean }
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
  | { kind: "ask_user"; id: string; question: string; choices: string[]; allowFreeText: boolean; defaultChoice?: string }
  /** Reply to a get_image_preview request: data URL or null when unavailable. */
  | { kind: "image_preview"; path: string; dataUrl: string | null };

/**
 * History projected from the persisted session. Mirrors the desktop
 * HistoryEntry: assistant messages carry their toolCalls, tool results come
 * back as separate entries so the webview can rebuild the same
 * text/tool-block layout the live stream produced.
 */
export type HistoryMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/**
 * An uploaded file after it has been copied into the per-session upload dir
 * (OS tmp, NOT the workspace folder). The `*_script` tools and analyze_image
 * whitelist this location via the agent's `uploadDir` option.
 */
export type AttachmentKind = "excel" | "docx" | "pdf" | "image";
/** @deprecated Use AttachmentKind — alias kept for older references. */
export type DocKind = AttachmentKind;

export interface PickedFile {
  /** Display name (original filename). */
  name: string;
  /** Attachment kind, derived from extension — drives chip icon + prompt tool. */
  kind: AttachmentKind;
  /**
   * Absolute path to the copied file in the OS tmp dir. Despite the field
   * name (kept for protocol stability), this is an absolute path, not
   * workspace-relative.
   */
  relPath: string;
  /** File size in bytes. */
  bytes: number;
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
  | { kind: "get_image_preview"; path: string }
  | { kind: "answer_user"; id: string; status: "answer" | "cancel"; answer: string };

export type ProviderName =
  | "deepseek"
  | "gemini"
  | "openai"
  | "openai-responses"
  | "grok"
  | "qwen"
  | "zai"
  | "claude"
  | "sibergate"
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

export type OptimizeMode = "drop" | "summary" | "recent" | "compact";

/** Reasoning levels forwarded to OpenAI-compatible gateways (desktop parity). */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";

export interface SettingsValues {
  provider: ProviderName;
  customProvider: CustomProviderSettings;
  multimodalProvider: MultimodalProviderSettings;
  model: string;
  /** Reasoning effort forwarded to custom OpenAI-compatible gateways. */
  reasoningEffort: ReasoningEffort;
  /** Maximum number of output tokens requested from the provider. */
  maxTokens: number;
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
