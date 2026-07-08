import type { Message } from "./types.js";

export type OptimizeMode = "drop" | "summary" | "recent" | "compact";

/**
 * Persisted state of an LLM-generated context summary. Mirrors
 * `SessionSummaryState` in the session layer but kept here too so core/agent
 * doesn't have to import from session just for this shape.
 */
export interface SummaryState {
  text: string;
  upToIndex: number;
  updatedAt: string;
}

export interface ContextOptimizeConfig {
  enabled: boolean;
  mode?: OptimizeMode;
  /**
   * Compact-mode: max prompt tokens (context window budget) of the active
   * provider, used by the threshold trigger. When undefined the agent falls
   * back to the SIBERFLOW_CONTEXT_WINDOW env var, then DEFAULT_CONTEXT_WINDOW.
   * Only honored when mode === "compact".
   */
  contextWindow?: number;
  /**
   * Compact-mode: ratio (0..1) of (last prompt tokens / contextWindow) at
   * which summarization fires. Default 0.8. Lower = compact sooner & more
   * often; higher = compact later. Only honored when mode === "compact".
   */
  compactThreshold?: number;
  /**
   * Compact-mode: how many of the most recent COMPLETED turns stay verbatim
   * (not folded into the summary) when compaction fires. Default 2.
   * Only honored when mode === "compact".
   */
  compactKeepRecent?: number;
}

export interface OptimizationStats {
  /** Number of tool calls dropped from previous turns. */
  collapsedCount: number;
  /** Approximate bytes removed from the request. */
  bytesSaved: number;
}

/**
 * Stats emitted when the "compact" mode generates/updates an LLM narrative
 * summary. Surfaces to the host via `AgentEvents.onContextCompacted`.
 */
export interface CompactionStats {
  /** Number of conversation turns folded into the summary this pass. */
  turnsSummarized: number;
  /** Length of the resulting summary text, in characters. */
  summaryChars: number;
}

/**
 * System prompt for the LLM summarization call used by "compact" mode. The
 * model is asked to produce a dense, fact-preserving narrative of the supplied
 * conversation turns, keeping user goals, key decisions, important tool
 * results, and files touched, while dropping pleasantries and raw payloads
 * already captured by shorter references.
 */
export const SUMMARY_SYSTEM_PROMPT = `You are a context summarizer for an AI coding agent. Summarize the following conversation turns into a dense, fact-preserving narrative. MUST keep:
- User requests and goals
- Key decisions and their rationale
- Important tool results (file paths read, commands run + outcomes, errors)
- Files created/modified/deleted
- Unresolved questions or blockers
Drop: pleasantries, redundant explanations, raw file contents already captured by path references. Output prose, max ~400 words. No preamble.`;

export const DEFAULT_OPTIMIZE_CONFIG: ContextOptimizeConfig = {
  enabled: true,
  mode: "compact",
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
  summary?: SummaryState | null,
): { messages: Message[]; stats: OptimizationStats } {
  const stats: OptimizationStats = { collapsedCount: 0, bytesSaved: 0 };

  if (!config.enabled) {
    return { messages: [...messages], stats };
  }

  const mode: OptimizeMode = config.mode ?? "compact";

  // Layer 2 — "compact": replace everything the LLM summary covers with the
  // summary itself (as a pseudo-system message), then append the messages
  // after `summary.upToIndex` verbatim. Unlike Layer 1 modes this requires an
  // LLM call to PRODUCE the summary (done by the agent before calling us), but
  // applying it here is still pure/deterministic: we just splice. When no
  // summary exists yet (before the first compaction threshold is crossed),
  // keep the full history verbatim — "compact" mode is meant to be the richest
  // retention mode, so we do NOT fall back to Layer 1 breadcrumb folding here.
  if (mode === "compact") {
    if (!summary || summary.text.trim().length === 0 || summary.upToIndex < 0) {
      // No summary yet — send the raw full history. The threshold trigger in
      // generateSummaryIncremental / foldCurrentTurnMidLoop decides WHEN to
      // start summarizing; until then, nothing is compressed.
      return { messages: [...messages], stats };
    }
    const upTo = Math.min(summary.upToIndex, messages.length - 1);
    // Defensive: snap the boundary down so the verbatim tail can't start with
    // an orphan `tool` message (no preceding assistant.tool_calls). The agent
    // already snaps when it generates the summary, but a corrupted/edited
    // session or a mismatched upToIndex could otherwise slip through here.
    const safeUpTo = snapToTurnBoundary(messages, upTo, -1);
    const tail = messages.slice(safeUpTo + 1);

    // Build the optimized view. PRESERVE the original system prompt at index 0
    // (agent instructions, persona, tool guidance) and inject the summary as a
    // labeled pseudo-user message right after it — so the model sees both its
    // original instructions AND the rolled-forward context summary. If there's
    // no system prompt in the history, the summary stands alone as the prefix.
    const hasSystem = messages[0]?.role === "system";
    const summaryMsg: Message = {
      role: "user",
      content: `[Conversation summary so far]\n${summary.text}`,
    };
    const optimized: Message[] = hasSystem
      ? [messages[0]!, summaryMsg, ...tail]
      : [summaryMsg, ...tail];
    // Approximate the bytes saved by replacing the summarized prefix with the
    // (much shorter) summary text, for parity with the other modes' stats.
    const head = messages.slice(0, safeUpTo + 1);
    const headBytes = head.reduce(
      (n, m) =>
        n +
        (m.role === "tool"
          ? m.content.length
          : (m.content?.length ?? 0) +
            (m.role === "assistant"
              ? (m.toolCalls?.reduce((a, tc) => a + tc.arguments.length, 0) ?? 0)
              : 0)),
      0,
    );
    stats.collapsedCount = head.length;
    stats.bytesSaved = Math.max(0, headBytes - summary.text.length);
    return { messages: optimized, stats };
  }

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
 * Snap a candidate end-index (inclusive) for the compact summary down to a
 * SAFE turn boundary — i.e. an index where slicing `messages[index+1:]` cannot
 * start mid-tool-call-chain (which would leave an orphan `tool` result without
 * a preceding `assistant.tool_calls`, rejected by strict providers as HTTP 400).
 *
 * A safe boundary is one of:
 *   - just before a `user` message (a user message always starts a new turn), OR
 *   - just before an `assistant` message whose `toolCalls` is empty/absent
 *     (a content-only assistant also starts a fresh turn), OR
 *   - just before an `assistant` that DOES carry tool_calls (the slice starts
 *     with the assistant's call, so any following tool results are well-formed).
 *
 * Walk backward from `startIndex` until we land on such a boundary. Returns
 * the safe index (inclusive), or `alreadySummarizedUpTo` if none exists before
 * it (conservative: fold nothing new rather than risk an orphan tool message).
 */
export function snapToTurnBoundary(
  messages: readonly Message[],
  startIndex: number,
  alreadySummarizedUpTo: number,
): number {
  for (let i = Math.min(startIndex, messages.length - 1); i > alreadySummarizedUpTo; i--) {
    const next = messages[i + 1];
    if (!next) return i; // end of array — always safe (nothing after)
    if (next.role === "user") return i;
    if (next.role === "assistant") return i; // assistant always starts fresh
    // next.role === "tool" → splitting here would orphan it. Keep walking back.
  }
  return alreadySummarizedUpTo; // no safe boundary found — fold nothing new
}

/**
 * Find the START index (inclusive) of the completed turn that is
 * `keepTurns` turns back from `fromIndex`. A "turn" is the unit of
 * conversation that begins at a `user` message and runs until the next
 * `user` message (or end of array). This is the per-TURN analog of a simple
 * index subtraction: instead of "keep N messages", it's "keep N completed
 * turns verbatim", so a heavy turn with many tool results counts as ONE unit.
 *
 * Walks backward from `fromIndex`, counting `user` messages as turn
 * boundaries. Returns the index of the `user` message that opens the
 * (keepTurns+1)-th turn from the end, minus 1 (i.e. the message just before
 * that turn starts — the safe summary end boundary). Returns
 * `alreadySummarizedUpTo` if there aren't enough turns to keep.
 *
 * Example: keepTurns=2, history = [user, asst, tool, asst, user, asst, user]
 *                                                       ^fromIndex (last user)
 *   2 turns back → the user at idx 4 starts the turn to keep; we return
 *   idx 3 (the assistant just before it) as the summary end boundary.
 */
export function findTurnBoundaryFromEnd(
  messages: readonly Message[],
  fromIndex: number,
  keepTurns: number,
  alreadySummarizedUpTo: number,
): number {
  if (keepTurns <= 0) {
    // Keep zero turns: fold everything up to and including fromIndex.
    return fromIndex;
  }
  let turnsSeen = 0;
  for (let i = fromIndex; i > alreadySummarizedUpTo; i--) {
    if (messages[i]!.role === "user") {
      turnsSeen++;
      if (turnsSeen === keepTurns) {
        // This user message opens the keepTurns-th turn from the end — the
        // OLDEST turn we still want to keep verbatim. Everything strictly
        // before it should be folded into the summary.
        return i - 1;
      }
    }
  }
  return alreadySummarizedUpTo; // not enough turns — fold nothing new
}

/**
 * Mid-turn sibling of `findTurnBoundaryFromEnd`. The current-turn region
 * `[snapshotEndIndex .. end]` contains NO `user` messages (it's all
 * assistant-with-toolCalls + tool results from THIS turn's iteration loop).
 * So we treat an `assistant` message that carries `toolCalls` as a sub-turn
 * boundary instead. Finds the end-index (inclusive) of the sub-turn that is
 * `keepSubTurns` sub-turns back from `fromIndex`, so the caller can fold
 * everything before it into the rolling summary.
 *
 * Walks backward counting assistant.toolCalls-bearing messages as boundaries.
 * Returns the index just before the (keepSubTurns+1)-th boundary from the end,
 * or `floor` if there aren't enough sub-turns to keep.
 */
export function findSubTurnBoundaryFromEnd(
  messages: readonly Message[],
  fromIndex: number,
  keepSubTurns: number,
  floor: number,
): number {
  if (keepSubTurns <= 0) {
    return fromIndex;
  }
  let subTurnsSeen = 0;
  for (let i = fromIndex; i > floor; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      subTurnsSeen++;
      if (subTurnsSeen === keepSubTurns) {
        // This assistant opens the keepSubTurns-th sub-turn from the end — the
        // OLDEST sub-turn we still want to keep verbatim. Everything strictly
        // before it should be folded into the summary.
        return i - 1;
      }
    }
  }
  return floor; // not enough sub-turns — fold nothing new
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

/**
 * Cap on per-message text length when serializing turns for the summarizer
 * LLM. Tool results and file contents can be huge; truncating keeps the
 * summarization prompt itself from bloating the very context we're trying to
 * shrink.
 */
const SERIALIZE_MSG_CAP = 2000;

/**
 * Flatten a slice of the message history into a single text block suitable as
 * user input to the summarization LLM. Each message renders as a labeled line
 * (`[role]`, `[role name]` for tool results), with overly long payloads
 * truncated to SERIALIZE_MSG_CAP chars. Used by `Agent.generateSummaryIncremental`
 * to build the summarization prompt.
 */
export function serializeTurns(messages: readonly Message[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      // Skip system messages — they're agent scaffolding, not conversation.
      continue;
    }
    if (m.role === "user") {
      out.push(`[user]: ${cap(m.content)}`);
      continue;
    }
    if (m.role === "assistant") {
      const calls = m.toolCalls?.length
        ? m.toolCalls.map((tc) => renderSignature(tc.name, tc.arguments)).join("; ")
        : null;
      const body = m.content && m.content.length > 0 ? cap(m.content) : "";
      out.push(`[assistant]: ${[calls ? `(called ${calls})` : null, body].filter(Boolean).join(" ")}`);
      continue;
    }
    if (m.role === "tool") {
      out.push(`[tool ${m.name}]: ${cap(m.content)}`);
      continue;
    }
    // Unreachable (system already skipped above), but keep exhaustive.
    continue;
  }
  return out.join("\n");
}

function cap(s: string): string {
  return s.length > SERIALIZE_MSG_CAP ? `${s.slice(0, SERIALIZE_MSG_CAP - 20)}\n…[truncated]` : s;
}
