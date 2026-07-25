/**
 * Standalone conversation compaction.
 *
 * This module is the single source of truth for the "AI summarization" path
 * of context optimization. It produces a dense narrative summary of older
 * conversation turns so they can be folded out of the request while keeping
 * their facts. The result is a {@link SummaryState} that a caller persists
 * (e.g. on the session) and that the deterministic `optimizeContext` step
 * splices into the next request when in "compact" mode.
 *
 * It is intentionally a PURE FUNCTION with no dependency on the {@link Agent}
 * class — only a {@link Provider} (to call the LLM) and the message list are
 * needed. That means the same routine backs:
 *   - the automatic start-of-turn compaction in Agent.send(),
 *   - a manual "Compact now" action on a host (e.g. the telegram admin panel),
 *   - and any future trigger (CLI subcommand, cron job, another host) without
 *     having to instantiate an Agent.
 *
 * Unlike the auto path, this function performs NO mode/threshold/enabled
 * guard — the caller decides when to invoke it. It never mutates the input
 * `messages`; it only returns a new {@link SummaryState} to store.
 */
import type { Provider } from "../providers/base.js";
import type { AssistantMessage, Message } from "./types.js";
import {
  SUMMARY_SYSTEM_PROMPT,
  findTurnBoundaryFromEnd,
  serializeTurns,
  snapToTurnBoundary,
  type SummaryState,
} from "./optimize.js";
import { debug } from "../debug.js";

export interface CompactEvents {
  /** Abort the in-flight LLM summarization call. */
  signal?: AbortSignal;
  /** Fired once before the summarization request is sent. */
  onStart?: () => void;
  /** Fired once after a summary is produced, with accounting stats. */
  onComplete?: (stats: {
    turnsSummarized: number;
    summaryChars: number;
    summary: SummaryState;
  }) => void;
}

export interface CompactOptions {
  /** LLM provider used for the summarization call. */
  provider: Provider;
  /** Model name to send to the provider. */
  model: string;
  /** Full conversation history (system + user + assistant + tool messages). */
  messages: readonly Message[];
  /**
   * Existing summary to roll forward, or null/undefined for the first
   * compaction. When present it's fed back into the prompt so the model
   * extends the prior narrative instead of restarting from scratch.
   */
  summary?: SummaryState | null;
  /**
   * Number of the most recent COMPLETED turns to keep verbatim (not folded
   * into the summary). Counted per-turn (user + its assistant/tool activity
   * = one unit), not per-message. Default 2.
   */
  keepRecent?: number;
  /**
   * Anti-rate-limit delay (ms) before the provider call. 0 = no delay.
   * Mirrors the agent's requestDelayMs so manual compaction is throttled the
   * same way as a normal turn.
   */
  requestDelayMs?: number;
  /** Event callbacks + abort signal. */
  events?: CompactEvents;
}

export interface CompactResult {
  /**
   * The new summary (or the prior summary unchanged when nothing was
   * eligible to fold). Null only when there was no prior summary and nothing
   * was folded.
   */
  summary: SummaryState | null;
  /** True when a fresh summary was actually produced/updated this call. */
  compacted: boolean;
  /** Accounting stats from the fold, or null when nothing was folded. */
  stats: { turnsSummarized: number; summaryChars: number } | null;
}

/**
 * Compact a conversation into a rolling narrative summary via an LLM call.
 *
 * Bypasses all auto-compact guards (mode / threshold / enabled) — the caller
 * decides when compaction should run. Never mutates `messages`; returns a new
 * {@link SummaryState} to store.
 *
 * The last message is treated as eligible to fold (this is the typical case:
 * manual compaction runs outside a chat turn, so there's no freshly-pushed
 * current user message to protect). Callers that DO want to reserve the last
 * message (e.g. the auto path inside Agent.send, where the last message is the
 * current user turn) should pass `messages` without it.
 *
 * Errors are surfaced to the caller (not swallowed) — unlike the auto path,
 * a manual compaction is an explicit user action and failures must be visible.
 *
 * @returns a {@link CompactResult}; `compacted` is false when there was
 *   nothing new to summarize (too few turns, or everything already covered by
 *   the prior summary).
 */
export async function compactConversation(
  opts: CompactOptions,
): Promise<CompactResult> {
  const { provider, model, messages, events } = opts;
  const keepRecent = opts.keepRecent ?? 2;
  const priorSummary = opts.summary ?? null;
  const signal = events?.signal;

  // Need at least one message to consider folding.
  if (messages.length < 1) {
    return { summary: priorSummary, compacted: false, stats: null };
  }

  // Treat the last message as eligible (manual compaction has no current-turn
  // user message to reserve). snapToTurnBoundary below still rewinds past any
  // orphaned trailing tool_calls so we never fold mid-tool-call-chain.
  const lastEligibleIdx = messages.length - 1;
  const alreadySummarizedUpTo = priorSummary?.upToIndex ?? -1;

  const candidate = findTurnBoundaryFromEnd(
    messages,
    lastEligibleIdx,
    keepRecent,
    alreadySummarizedUpTo,
  );
  const summarizeUpTo = snapToTurnBoundary(
    messages,
    candidate,
    alreadySummarizedUpTo,
  );
  // Nothing new to fold in (or no safe boundary was found).
  if (summarizeUpTo <= alreadySummarizedUpTo) {
    return { summary: priorSummary, compacted: false, stats: null };
  }

  const turnsToSummarize = messages.slice(
    alreadySummarizedUpTo + 1,
    summarizeUpTo + 1,
  );
  if (turnsToSummarize.length === 0) {
    return { summary: priorSummary, compacted: false, stats: null };
  }

  // Build the summarization prompt. The prior summary (if any) is fed back in
  // so the model rolls it forward instead of restarting from scratch.
  const summaryPrompt: Message[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    ...(priorSummary
      ? [
          {
            role: "user" as const,
            content: `Previous summary (update and extend it; preserve its key facts):\n${priorSummary.text}`,
          },
        ]
      : []),
    {
      role: "user",
      content:
        `Conversation turns to summarize (roles: user, assistant, tool):\n\n` +
        serializeTurns(turnsToSummarize),
    },
  ];

  debug(
    `📦 compact: summarizing ${turnsToSummarize.length} message(s) [${alreadySummarizedUpTo + 1}..${summarizeUpTo}]`,
  );
  events?.onStart?.();

  // Optional anti-rate-limit pause, mirroring the agent's runStream throttle.
  if ((opts.requestDelayMs ?? 0) > 0) {
    await sleep(opts.requestDelayMs ?? 0, signal);
  }
  throwIfAborted(signal);

  const text = await runSummaryProviderCall(provider, model, summaryPrompt, signal);
  if (text.length === 0) {
    debug("📦 compact: model returned empty summary, keeping prior state");
    return { summary: priorSummary, compacted: false, stats: null };
  }

  const newSummary: SummaryState = {
    text,
    upToIndex: summarizeUpTo,
    updatedAt: new Date().toISOString(),
  };
  const stats = {
    turnsSummarized: turnsToSummarize.length,
    summaryChars: text.length,
  };
  events?.onComplete?.({ ...stats, summary: newSummary });
  debug(
    `📦 compact: summary updated (${text.length} chars), covers up to index ${summarizeUpTo}`,
  );
  return { summary: newSummary, compacted: true, stats };
}

/**
 * Drive the provider's streaming chat API for a summarization call (no tools,
 * no UI streaming). Collects the streamed content deltas into the final
 * assistant text and returns it trimmed. Throws on abort or if the stream
 * ends without a final message.
 */
async function runSummaryProviderCall(
  provider: Provider,
  model: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<string> {
  let assistant: AssistantMessage | null = null;
  try {
    for await (const ev of provider.chatStream({ model, messages, tools: [], signal })) {
      throwIfAborted(signal);
      if (ev.type === "done") {
        assistant = ev.message;
      }
    }
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    throw err;
  }
  if (!assistant) {
    throw new Error("Provider stream ended without a final message");
  }
  return (assistant.content ?? "").trim();
}

// ── Local helpers (kept private to this module to avoid a hard dependency on
//    agent.ts, which would defeat the "standalone" goal). These are tiny
//    copies of the equivalents in agent.ts. ────────────────────────────────

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const err = new Error("Request aborted");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
