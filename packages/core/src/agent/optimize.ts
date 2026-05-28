import type { Message } from "./types.js";

export interface ContextOptimizeConfig {
  enabled: boolean;
}

export interface OptimizationStats {
  /** Number of tool calls dropped from previous turns. */
  collapsedCount: number;
  /** Approximate bytes removed from the request. */
  bytesSaved: number;
}

export const DEFAULT_OPTIMIZE_CONFIG: ContextOptimizeConfig = {
  enabled: false,
};

/**
 * Strips tool activity from previous turns, keeping only the assistant's
 * final text answer per turn. Returns a NEW array; input is not mutated.
 *
 * Dropped:
 *   - every `tool` result message
 *   - every assistant message that made tool calls (the intermediate
 *     "let me check X" + tool_calls messages)
 *
 * Kept: system, user, and content-only assistant messages (the final
 * answers). No breadcrumbs — leaving "[called read_file ...]" notes was
 * found to confuse the model into re-running tools, so the trace is
 * removed entirely. The assistant's final summary text carries forward
 * whatever matters.
 *
 * Layer 1: deterministic, no LLM call. Called ONCE at the start of
 * `agent.send()`, so it only ever sees completed previous turns; the
 * current turn's messages are appended afterward and never pass through.
 */
export function optimizeContext(
  messages: readonly Message[],
  config: ContextOptimizeConfig,
): { messages: Message[]; stats: OptimizationStats } {
  const stats: OptimizationStats = { collapsedCount: 0, bytesSaved: 0 };

  if (!config.enabled) {
    return { messages: [...messages], stats };
  }

  const kept: Message[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      stats.bytesSaved += m.content.length;
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      stats.collapsedCount += m.toolCalls.length;
      stats.bytesSaved += m.content?.length ?? 0;
      for (const tc of m.toolCalls) stats.bytesSaved += tc.arguments.length;
      continue;
    }
    kept.push(m);
  }

  // Defensive: dropping a whole turn's tool activity can leave two
  // same-role messages adjacent (e.g. a turn that produced no final text).
  // Merge them so the request never has back-to-back same-role messages.
  const result: Message[] = [];
  for (const m of kept) {
    const last = result[result.length - 1];
    if (last && last.role === "user" && m.role === "user") {
      result[result.length - 1] = {
        role: "user",
        content: `${last.content}\n${m.content}`,
      };
      continue;
    }
    if (last && last.role === "assistant" && m.role === "assistant") {
      const a = last.content ?? "";
      const b = m.content ?? "";
      result[result.length - 1] = {
        role: "assistant",
        content: a && b ? `${a}\n${b}` : a || b || null,
      };
      continue;
    }
    result.push(m);
  }

  return { messages: result, stats };
}
