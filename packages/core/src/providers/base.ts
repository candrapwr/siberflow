import type { ChatRequest, StreamEvent } from "../agent/types.js";

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_STREAM_TERMINAL_DRAIN_TIMEOUT_MS = 10_000;

/** Standard reasoning-effort values forwarded to a custom gateway. */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface Provider {
  readonly name: string;
  readonly defaultModel: string;
  chatStream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  customName?: string;
  customDefaultModel?: string;
  /** Reasoning effort forwarded to the custom OpenAI-compatible gateway. */
  reasoningEffort?: ReasoningEffort;
  /** Cancel a stream after this many milliseconds without provider data. */
  streamIdleTimeoutMs?: number;
}
