import type { Message } from "./types.js";

export type OptimizeMode = "drop" | "summary";

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
  mode: "summary",
};

/**
 * Strip tool activity from previous turns. Returns a NEW array; input is not
 * mutated. Runs ONCE at the start of `agent.send()`, so it only ever sees
 * completed previous turns; the current turn's messages are appended after
 * and never pass through here.
 *
 * Layer 1: deterministic, no LLM call.
 *
 * Two modes share the same "what to drop" rule — the ONLY difference is what
 * (if anything) is left behind as a breadcrumb for the model:
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
 * In both modes, after dropping we merge any adjacent same-role messages
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

  const mode: OptimizeMode = config.mode ?? "summary";

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
  const merged: Message[] = [];
  for (const m of result) {
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

  return { messages: merged, stats };
}
