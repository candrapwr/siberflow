export type Role = "system" | "user" | "assistant" | "tool";

/**
 * Multimodal content block for a user turn. Mirrors the OpenAI-compatible
 * `content` array shape. Only `user` messages ever carry blocks today; the
 * native-vision flow (analyze_image_native) injects an image here so the MAIN
 * model reads it with its own vision, instead of a separate sub-model.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "low" | "high" | "auto" };
    };

export interface TextMessage {
  role: "system" | "user";
  /** String for ordinary turns; a block array when a user turn carries an image. */
  content: string | ContentBlock[];
}

/**
 * Flatten a message content (string or block array) to plain text. Used by the
 * many history/optimization consumers that only reason about text, so widening
 * `content` never forces a `typeof` check at every call site. Image blocks are
 * rendered as a stable, non-destructive placeholder rather than base64.
 */
export function contentToText(
  content: string | ContentBlock[],
): string {
  if (typeof content === "string") return content;
  const out: string[] = [];
  for (const block of content) {
    if (block.type === "text") out.push(block.text);
    else out.push("[image]");
  }
  return out.join("\n");
}

/** Deterministic stand-in shown to the model when vision mode is OFF and the
 *  history still contains injected image blocks. Text-only providers / gateways
 *  never see image_url blocks, and no data is lost: the real blocks remain in
 *  the host's message store, so re-enabling vision restores them verbatim. */
const IMAGE_PLACEHOLDER_TEXT =
  "[image removed — native vision mode is OFF. The image was analyzed earlier " +
  "while vision mode was on; rely on the assistant's description in the " +
  "preceding turns. Re-enable vision mode to view it again.]";

/**
 * Build a vision-mode-aware VIEW of the conversation for a single provider
 * request. When `visionMode` is true this returns the messages unchanged. When
 * false, every `image_url` block in a user message is replaced with a text
 * placeholder (adjacent text blocks are kept). Pure function: the caller's
 * message array is never mutated.
 */
export function toVisionAwareMessages(
  messages: readonly Message[],
  visionMode: boolean,
): Message[] {
  if (visionMode) return [...messages];
  let hasImages = false;
  const out = messages.map((m) => {
    if ((m.role === "user" || m.role === "system") && Array.isArray(m.content)) {
      hasImages = true;
      const blocks: ContentBlock[] = [];
      for (const b of m.content) {
        if (b.type === "image_url") {
          blocks.push({ type: "text", text: IMAGE_PLACEHOLDER_TEXT });
        } else {
          blocks.push(b);
        }
      }
      return { role: m.role, content: blocks };
    }
    return m;
  });
  return hasImages ? out : [...messages];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type Message = TextMessage | AssistantMessage | ToolResultMessage;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  textTokens?: number;
}

export type StreamEvent =
  | { type: "content"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | {
      type: "done";
      message: AssistantMessage;
      finishReason: FinishReason;
      usage?: UsageStats;
    };
