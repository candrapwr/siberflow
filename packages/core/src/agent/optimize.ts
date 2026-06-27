import type { Message } from "./types.js";

export type OptimizeMode = "drop" | "summary" | "recent";

export interface ContextOptimizeConfig {
  enabled: boolean;
  mode?: OptimizeMode;
}

export interface OptimizationStats {
  /** Number of tool calls dropped from previous turns. */
  collapsedCount: number;
  /** Approximate bytes removed from the request. */
  bytesSaved: number;
}

export const DEFAULT_OPTIMIZE_CONFIG: ContextOptimizeConfig = {
  enabled: true,
  mode: "recent",
};

/**
 * Strip tool activity from previous turns. Returns a NEW array; input is not
 * mutated. Runs ONCE at the start of `agent.send()`, so it only ever sees
 * completed previous turns; the current turn's messages are appended after
 * and never pass through here.
 *
 * Layer 1: deterministic, no LLM call.
 *
 * Three modes share the same "what to drop" rule — the difference is what
 * (if anything) is left behind as a breadcrumb, and which turns get it:
 *
 *   drop    — remove every tool result and every assistant message that made
 *             tool calls. Keep system/user/content-only-assistant messages.
 *             No trace left. The model must re-run tools if it needs detail.
 *
 *   summary — drop the same tool activity, BUT tag the user message that
 *             started the turn with a `[SUMMARY]` block listing tool
 *             SIGNATURES — the tool name plus its short identifier args
 *             (e.g. `exec("df -h")`, `write_file("src/foo.ts")`). Heavy
 *             payload fields (file content, edit patches, task lists) and
 *             tool results are both removed, so the breadcrumb stays compact
 *             while still telling the model WHAT was touched in that turn
 *             without leaking potentially-stale values.
 *
 *   recent  — like "summary" (signature breadcrumbs on dropped turns), but
 *             keeps the MOST RECENT completed turn's tool activity UNTOUCHED
 *             so the model still has the last tool results verbatim. Only
 *             turns older than that last turn get compressed. Use this when
 *             the immediately preceding tool context matters and shouldn't
 *             be reduced to a signature yet.
 *
 *             When invoked, `optimizeContext` is called AFTER the current
 *             turn's user message was pushed, so "the last completed turn"
 *             = the second-to-last user message onward. Everything before it
 *             is compressed (with signatures); from that user message to the
 *             end (including the current turn, appended later as `extras`)
 *             stays full. If there's no second-to-last user message (i.e.
 *             this is the first or second turn), nothing is compressed and
 *             behavior is identical to optimization disabled.
 *
 * In all modes, after dropping we merge any adjacent same-role messages
 * defensively (dropping a turn's tool activity can otherwise leave two
 * user or two assistant messages back to back).
 */

/**
 * Payload fields dropped when building a summary signature — they're large
 * (file contents, edit patches, the full task list) and carry most of the
 * bytes we're trying to save. Identifier fields (path, command, query,
 * offsets, …) are kept because they're short and tell the model WHAT was
 * touched, which is the whole point of the breadcrumb.
 */
const PAYLOAD_FIELDS = new Set([
  "content", // write_file
  "new_string", // edit_file
  "old_string", // edit_file
  "tasks", // task_update
  "data", // generic bulk payloads
]);

/** Max identifier args rendered per signature before truncating with "…". */
const MAX_SIGNATURE_ARGS = 3;

/**
 * Render a compact tool signature from raw JSON arguments:
 *   exec({"command":"df -h"})                   -> exec("df -h")
 *   write_file({"path":"a.ts","content":…})     -> write_file("a.ts")
 *   read_file({"path":"x","offset":1,"limit":50}) -> read_file("x", 1-50)
 *   task_update({"tasks":[…]})                  -> task_update()
 *
 * Payload fields are dropped; remaining identifier fields render as short
 * quoted values. Falls back to just the tool name if args don't parse.
 */
export function renderSignature(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return name;
  }

  const entries = Object.entries(args).filter(
    ([k]) => !PAYLOAD_FIELDS.has(k),
  );
  if (entries.length === 0) {
    // Only payload fields (e.g. write_file with just content) — no
    // meaningful identifier to show, drop the arg list entirely.
    return name;
  }

  const rendered: string[] = [];
  for (const [k, v] of entries) {
    if (rendered.length >= MAX_SIGNATURE_ARGS) {
      rendered.push("…");
      break;
    }
    // read_file offset+limit collapse to a compact range: "x", 1-50
    if (k === "offset" && entries.some(([k2]) => k2 === "limit")) continue;
    if (k === "limit") {
      const offset = args.offset;
      if (typeof offset === "number" && typeof v === "number") {
        rendered.push(`${offset}-${v}`);
      } else {
        rendered.push(`limit=${shortVal(v)}`);
      }
      continue;
    }
    rendered.push(shortVal(v));
  }

  return `${name}(${rendered.join(", ")})`;
}

/** Render a single arg value compactly for a signature. */
function shortVal(v: unknown): string {
  if (typeof v === "string") {
    const s = v.length > 60 ? `${v.slice(0, 57)}…` : v;
    return JSON.stringify(s);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return "…";
}

export function optimizeContext(
  messages: readonly Message[],
  config: ContextOptimizeConfig,
): { messages: Message[]; stats: OptimizationStats } {
  const stats: OptimizationStats = { collapsedCount: 0, bytesSaved: 0 };

  if (!config.enabled) {
    return { messages: [...messages], stats };
  }

  const mode: OptimizeMode = config.mode ?? "recent";

  // "recent" keeps the most recent completed turn's tool activity intact and
  // compresses (with summary signatures) everything strictly before it. The
  // current turn's user message is the LAST message here (already pushed by
  // the agent before calling us), so the last completed turn = everything
  // from the second-to-last user message onward. If there's no such message
  // (first/second turn), nothing is eligible — behave like disabled.
  if (mode === "recent") {
    const keepStart = findSecondLastUserIndex(messages);
    if (keepStart === -1) {
      return { messages: [...messages], stats };
    }
    const head = compressToolHistory(messages.slice(0, keepStart), "summary", stats);
    const tail = messages.slice(keepStart);
    // head ends in a system/user/assistant content message; tail starts with
    // a user message — roles can't collide, so no merge needed. But run it
    // anyway defensively (cheap, and keeps the invariant for callers).
    return { messages: mergeAdjacent([...head, ...tail]), stats };
  }

  // drop / summary compress the entire message list.
  return { messages: compressToolHistory(messages, mode, stats), stats };
}

/**
 * Find the index of the SECOND-to-last user message in the list. Returns -1
 * if there are fewer than two user messages (the caller treats that as "no
 * turn to compress"). Used by the "recent" mode to locate where the most
 * recent completed turn begins.
 */
function findSecondLastUserIndex(messages: readonly Message[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      count++;
      if (count === 2) return i;
    }
  }
  return -1;
}

/**
 * Single-pass tool-activity compression shared by the drop/summary modes.
 * `recent` calls this with mode "summary" on the prefix it wants compressed.
 * Mutates the provided `stats` accumulator (callers merge stats back).
 *
 * Returns the compressed message list, with adjacent same-role messages
 * defensively merged (dropping a turn's tool activity can otherwise leave
 * two user or two assistant messages back to back).
 */
function compressToolHistory(
  messages: readonly Message[],
  mode: "drop" | "summary",
  stats: OptimizationStats,
): Message[] {
  // Pass 1: drop tool activity, collecting tool names per user turn for the
  // summary breadcrumb. `pendingUserIdx` tracks the user message that opened
  // the current turn so we can tag it once we know the full tool set.
  const result: Message[] = [];
  // Per-turn tool signatures for the summary breadcrumb. Built from the
  // assistant's tool_calls (we have the raw args there to render a compact
  // signature); tool result messages only carry the name, so they're a
  // fallback for any call whose args we couldn't see.
  const turnSignatures: string[] = [];
  const turnSeenNames = new Set<string>();
  let pendingUserIdx = -1;

  const finalizePendingUser = (): void => {
    if (mode === "summary" && pendingUserIdx !== -1 && turnSignatures.length > 0) {
      const u = result[pendingUserIdx] as { role: "user"; content: string };
      u.content = `${u.content}\n\n\n[SUMMARY]\n${turnSignatures.join("\n")}`;
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      finalizePendingUser();
      result.push(m);
      pendingUserIdx = -1;
      turnSignatures.length = 0;
      turnSeenNames.clear();
      continue;
    }

    if (m.role === "user") {
      finalizePendingUser();
      result.push({ role: "user", content: m.content });
      pendingUserIdx = result.length - 1;
      turnSignatures.length = 0;
      turnSeenNames.clear();
      continue;
    }

    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        // Intermediate assistant that issued tool calls — dropped in BOTH
        // modes. Record compact signatures (summary breadcrumb) + accounting.
        stats.collapsedCount += m.toolCalls.length;
        stats.bytesSaved += m.content?.length ?? 0;
        for (const tc of m.toolCalls) {
          stats.bytesSaved += tc.arguments.length;
          if (mode === "summary") {
            turnSignatures.push(renderSignature(tc.name, tc.arguments));
            turnSeenNames.add(tc.name);
          }
        }
        continue;
      }
      // Content-only assistant (the turn's final answer) — kept verbatim.
      result.push(m);
      continue;
    }

    if (m.role === "tool") {
      // Tool result — dropped in both modes. Name-only fallback: if a tool
      // call's args weren't visible on the assistant message (shouldn't
      // happen, but be defensive), at least record the bare name.
      stats.bytesSaved += m.content.length;
      if (mode === "summary" && !turnSeenNames.has(m.name)) {
        turnSignatures.push(m.name);
        turnSeenNames.add(m.name);
      }
      continue;
    }
  }
  finalizePendingUser();

  // Pass 2: defensive merge of adjacent same-role messages.
  return mergeAdjacent(result);
}

/**
 * Merge adjacent same-role messages (user/user, assistant/assistant) into a
 * single message so the output stays a valid alternating role sequence.
 * Assistant content is guaranteed non-empty (falls back to a space) to avoid
 * strict OpenAI-compatible servers rejecting empty assistant content.
 */
function mergeAdjacent(messages: readonly Message[]): Message[] {
  const merged: Message[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === "user" && m.role === "user") {
      merged[merged.length - 1] = {
        role: "user",
        content: `${last.content}\n${m.content}`,
      };
      continue;
    }
    if (last && last.role === "assistant" && m.role === "assistant") {
      const a = last.content ?? "";
      const b = m.content ?? "";
      const combined = a && b ? `${a}\n${b}` : a || b;
      merged[merged.length - 1] = {
        role: "assistant",
        content: combined.length > 0 ? combined : " ",
      };
      continue;
    }
    merged.push(m);
  }
  return merged;
}
