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
 * Replacement left in place of an `image_url` block once the image's own turn
 * is over. Native-vision base64 payloads are the single largest silent weight
 * a long session carries: a 2–5 MB data URL stays in history AND in every
 * persisted checkpoint forever. The model only ever needs the image DURING
 * the turn it reads it (the assistant description + the provenance text
 * survive), so the pixels are dropped at the start of the NEXT turn and
 * replaced by this note — the file itself stays on disk and can be re-read
 * via analyze_image_native with the original path.
 */
export const IMAGE_READ_NOTE_TEXT =
  "[image removed from history after being read, to save context — re-read " +
  "it with analyze_image_native using the original file path if you still need it]";

/**
 * Permanently strip `image_url` blocks from every message EXCEPT the newest
 * `keepRecent` ones (those may still be the active turn's injections — the
 * model must see their pixels). Blocks become a short text note; a message
 * whose blocks were ALL images collapses back to plain string content, which
 * keeps old hosts/serializers (and turn-boundary logic) seeing the canonical
 * shape. Returns the number of image blocks removed; returns 0 fast when no
 * stale images exist, so callers can run this every turn without cost.
 *
 * Rationale: a native-vision image is base64 (often MBs) that lives in
 * `this.messages` and every persisted checkpoint for the session's lifetime.
 * Its pixels are only useful in the turn they were read — the assistant's
 * description of it is already in history — so later turns should not pay
 * for it. The file remains on disk; the tool can re-read it on demand.
 */
export function stripStaleImageBlocks(
  messages: Message[],
  keepRecent = 1,
): number {
  let removed = 0;
  const protectFrom = Math.max(0, messages.length - keepRecent);
  for (let i = 0; i < protectFrom; i++) {
    const m = messages[i]!;
    if (!Array.isArray(m.content)) continue;
    if (!m.content.some((b) => b.type === "image_url")) continue;
    const blocks: ContentBlock[] = [];
    for (const b of m.content) {
      if (b.type === "image_url") {
        removed++;
        blocks.push({ type: "text", text: IMAGE_READ_NOTE_TEXT });
      } else {
        blocks.push(b);
      }
    }
    if (removed > 0) {
      const allImages = m.content.every((b) => b.type === "image_url");
      (m as { content: string | ContentBlock[] }).content = allImages
        ? IMAGE_READ_NOTE_TEXT
        : blocks;
    }
  }
  return removed;
}

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
