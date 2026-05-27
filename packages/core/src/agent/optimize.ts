import type { Message } from "./types.js";

export interface ContextOptimizeConfig {
  enabled: boolean;
}

export interface OptimizationStats {
  /** Number of items (tool results or tool-call argument strings) replaced. */
  truncatedCount: number;
  /** Total bytes saved by replacements (over the wire). */
  bytesSaved: number;
}

export const DEFAULT_OPTIMIZE_CONFIG: ContextOptimizeConfig = {
  enabled: false,
};

/**
 * Returns a new messages array with every `tool` result content AND every
 * assistant tool-call `arguments` string replaced by a short placeholder.
 * The original messages array is not mutated.
 *
 * Both directions of bloat are addressed:
 *   - Tool results (e.g. `read_file` returning 500 lines)
 *   - Tool call args (e.g. `write_file({content: "<huge>"})`, `edit_file`, `exec`)
 *
 * Layer 1: deterministic, no LLM call.
 *
 * Called ONCE at the start of `agent.send()`. At that point every tool
 * call/result in the array belongs to previous user turns; current turn's
 * items are appended later and never see this function.
 */
export function optimizeContext(
  messages: readonly Message[],
  config: ContextOptimizeConfig,
): { messages: Message[]; stats: OptimizationStats } {
  const stats: OptimizationStats = { truncatedCount: 0, bytesSaved: 0 };

  if (!config.enabled) {
    return { messages: [...messages], stats };
  }

  // Snapshot ORIGINAL args before any replacement so the tool result
  // placeholder can still describe what was called.
  const originalArgsById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) originalArgsById.set(tc.id, tc.arguments);
    }
  }

  const next = messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      let changed = false;
      const newCalls = m.toolCalls.map((tc) => {
        const orig = tc.arguments;
        const placeholder = `{"_truncated":"${tc.name} args, ${orig.length} bytes"}`;
        if (placeholder.length >= orig.length) return tc;
        stats.truncatedCount += 1;
        stats.bytesSaved += orig.length - placeholder.length;
        changed = true;
        return { ...tc, arguments: placeholder };
      });
      if (!changed) return m;
      return { ...m, toolCalls: newCalls };
    }

    if (m.role === "tool") {
      const original = m.content;
      const argsSummary = shortenArgs(originalArgsById.get(m.toolCallId) ?? "");
      const placeholder = `[truncated tool result: ${m.name}(${argsSummary}) — original ${original.length} bytes]`;
      if (placeholder.length >= original.length) return m;
      stats.truncatedCount += 1;
      stats.bytesSaved += original.length - placeholder.length;
      return { ...m, content: placeholder };
    }

    return m;
  });

  return { messages: next, stats };
}

function shortenArgs(json: string): string {
  if (json.length === 0) return "";
  const MAX = 60;
  if (json.length <= MAX) return json;
  return json.slice(0, MAX - 3) + "...";
}
