import type { Provider } from "../providers/base.js";
import type { ToolRegistry, ToolContext } from "../tools/index.js";
import { toSchema } from "../tools/base.js";
import {
  DEFAULT_OPTIMIZE_CONFIG,
  SUMMARY_SYSTEM_PROMPT,
  findSubTurnBoundaryFromEnd,
  findTurnBoundaryFromEnd,
  optimizeContext,
  serializeTurns,
  snapToTurnBoundary,
  type CompactionStats,
  type ContextOptimizeConfig,
  type OptimizationStats,
  type SummaryState,
} from "./optimize.js";
import { TaskStore, renderTaskList, type Task } from "./tasks.js";
import { debug } from "../debug.js";
import type {
  AssistantMessage,
  FinishReason,
  Message,
  ToolCall,
  ToolResultMessage,
  UsageStats,
} from "./types.js";

const MAX_AUTO_CONTINUES = 4;
/**
 * How many of the most recent COMPLETED turns the "compact" mode keeps
 * verbatim in the request (not folded into the LLM summary). Mirrors the
 * "recent" mode's intuition that the immediately preceding tool context
 * matters and shouldn't be reduced to prose. Tunable via
 * SIBERFLOW_COMPACT_KEEP_RECENT. A value of 0 folds everything older than the
 * current turn.
 */
/** Default maximum consecutive run_browser calls before the agent forces a
 * final answer. Overridable via SIBERFLOW_MAX_CONSECUTIVE_RUN_BROWSER env. */
const DEFAULT_MAX_CONSECUTIVE_RUN_BROWSER = 10;
const CONTINUE_NUDGE =
  "Your previous message was cut off by the output length limit. Continue from exactly where you stopped — do not repeat anything you already wrote, and do not add a preamble.";

/**
 * Default context window (max prompt tokens) assumed for the active provider
 * when neither the host config nor SIBERFLOW_CONTEXT_WINDOW supplies one. 200K
 * matches GLM-5.x / Claude-class models; DeepSeek/Qwen with 1M will simply
 * compact later. This is only the FALLBACK for the compact-mode threshold
 * trigger — the actual hard limit is enforced by the provider.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/**
 * Default ratio of (last prompt tokens / context window) at which "compact"
 * mode fires its summarization pass. 0.8 = summarize once the request reaches
 * 80% of the budget, leaving headroom for tool results and the reply.
 */
export const DEFAULT_COMPACT_THRESHOLD = 0.8;
/**
 * Default number of most recent COMPLETED turns kept verbatim (not folded into
 * the LLM summary) when compaction fires.
 */
export const DEFAULT_COMPACT_KEEP_RECENT = 2;

/**
 * Resolve the run_browser consecutive-call cap from the environment, falling
 * back to the built-in default. Reads at module load so changing it only needs
 * a process restart. A value of 0 disables the cap entirely (no limit).
 */
const MAX_CONSECUTIVE_RUN_BROWSER = (() => {
  const raw = process.env.SIBERFLOW_MAX_CONSECUTIVE_RUN_BROWSER;
  if (raw === undefined) return DEFAULT_MAX_CONSECUTIVE_RUN_BROWSER;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_CONSECUTIVE_RUN_BROWSER;
  return n;
})();

/**
 * Parse a positive integer from env, falling back to `def` on missing/garbage.
 * Used for the compact-mode env fallbacks (CLI/Telegram path).
 */
function envInt(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export interface AgentOptions {
  provider: Provider;
  registry: ToolRegistry;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  /**
   * Milliseconds to wait before each request to the LLM (anti rate-limit, so
   * fast tool-call loops don't trip provider throttling). 0 = no delay.
   * The agent itself defaults to 0; the config/settings layers (CLI env,
   * VSCode/Desktop settings) supply the user-facing default of 1500ms.
   */
  requestDelayMs?: number;
  /** Sandbox root that file tools and exec are restricted to. */
  projectDir?: string;
  /**
   * Optional per-session tmp dir that `excel_script` may read uploaded files
   * from (outside the project sandbox). Other file tools ignore this. When
   * unset, `excel_script` can only read files inside `projectDir`.
   */
  uploadDir?: string;
  /**
   * Ask-the-user callback injected into the tool context. When set, the
   * `ask_user` tool can call it to block on a user response (modal dialog in
   * the host UI). Omit for non-interactive hosts (CLI) where ask_user falls
   * back to a no-op message.
   */
  askUser?: ToolContext["askUser"];
  /** Optional bot host injected for bot_script. */
  botScript?: ToolContext["botScript"];
  /** Identity of the user who triggered this turn (forwarded to ToolContext). */
  userId?: ToolContext["userId"];
  /** Optional image-tool access logger (forwarded to ToolContext). */
  imageAccessLogger?: ToolContext["imageAccessLogger"];
  /** Optional context optimization (default: disabled). */
  contextOptimize?: ContextOptimizeConfig;
  /**
   * Seed value for the compact-mode threshold trigger's `lastPromptTokens`
   * (typically restored from `Session.usage.last.promptTokens` on resume).
   * Lets a freshly-loaded large session compact on its very first turn
   * instead of waiting for one round-trip to re-measure. Optional; defaults 0.
   */
  lastPromptTokens?: number;
  /** Enable task checklist injection (the task_update tool must also be registered). */
  tasksEnabled?: boolean;
  /** Auto-continue responses cut off by max output tokens (default: true). */
  autoContinue?: boolean;
  /**
   * Pre-truncate large tool outputs/arguments to keep context lean (default:
   * true). Read in ToolContext.preTruncate by read_file/exec, and used here to
   * digest write_file/edit_file arguments after execution.
   */
  preTruncate?: boolean;
  /** Max iterations for subagents (defaults to parent's maxIterations). */
  subagentMaxIterations?: number;
}

export interface AgentEvents {
  signal?: AbortSignal;
  onAssistantStart?: () => void;
  onContent?: (delta: string) => void;
  onAssistantEnd?: (
    msg: AssistantMessage,
    meta: { finishReason: FinishReason; usage?: UsageStats },
  ) => void;
  onToolCallStart?: (index: number, name: string) => void;
  onToolCallArgs?: (index: number, delta: string) => void;
  onToolResult?: (index: number, name: string, result: string) => void;
  /** Fires per LLM call when context optimization truncates at least one tool result. */
  onContextOptimized?: (stats: OptimizationStats) => void;
  /**
   * Fires when the "compact" mode generates or updates the LLM narrative
   * summary of older turns (one summary LLM call was made). Hosts can use this
   * to surface compaction in the UI or persist the updated summary.
   */
  onContextCompacted?: (stats: CompactionStats) => void;
  /** Fires after the task list changes (task_update tool called). */
  onTasksUpdated?: (tasks: readonly Task[]) => void;
  /** Fires when the turn hit the maxIterations cap without a final answer. */
  onMaxIterations?: (limit: number) => void;
  /**
   * Fires right BEFORE the agent executes a batch of 2+ parallel tool calls
   * from one assistant message. Single tool calls (count < 2) do NOT fire this
   * — hosts use it to open a "tool group" container so the batch renders as
   * one collapsible card. Always balanced by a later `onToolBatchEnd`.
   */
  onToolBatchStart?: (count: number) => void;
  /** Fires right AFTER a tool-call batch completes (mirrors onToolBatchStart). */
  onToolBatchEnd?: () => void;
  /**
   * Fires right BEFORE the "compact" mode makes an LLM summarization call
   * (start-of-turn `generateSummaryIncremental` or mid-loop
   * `foldCurrentTurnMidLoop`). Hosts show a "Summarizing context…" indicator.
   * Always paired with a later `onContextCompacted` once the call resolves.
   */
  onContextCompacting?: () => void;
  /** Fires when a subagent reports progress (phase: thinking|tool|tool_done|done, detail: tool name/preview). */
  onSubagentUpdate?: (phase: string, detail?: string) => void;
}

export class Agent {
  private readonly provider: Provider;
  private readonly registry: ToolRegistry;
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly requestDelayMs: number;
  private readonly ctx: ToolContext;
  private readonly contextOpt: ContextOptimizeConfig;
  /** Compact-mode tuning, resolved from config → env → default at construction. */
  private readonly contextWindow: number;
  private readonly compactThreshold: number;
  private readonly compactKeepRecent: number;
  private readonly tasksEnabled: boolean;
  private readonly autoContinue: boolean;
  /** Cap for subagent iterations; falls back to this.maxIterations when unset. */
  private readonly subagentMaxIterations: number;
  /** In-flight send() events, used by subagentProgress callback to forward to UI. */
  private currentEvents: AgentEvents | null = null;
  private readonly taskStore = new TaskStore();
  private readonly messages: Message[] = [];
  /**
   * Consecutive run_browser call counter. Tracks how many run_browser calls
   * have happened IN A ROW without any other tool in between. Reset to 0 when
   * a non-run_browser tool is called, AND at the start of every turn (send()).
   * When it exceeds MAX_CONSECUTIVE_RUN_BROWSER, further run_browser calls are
   * short-circuited with an informational tool result so the model breaks the
   * browsing loop. Guards against the agent getting stuck scraping endlessly.
   */
  private consecutiveRunBrowserCount = 0;
  /**
   * LLM-generated narrative summary of older turns, used by the "compact"
   * optimize mode. Set via `loadSummary()` when restoring a session, and
   * rolled forward by `generateSummaryIncremental()` each turn the compact
   * mode is active. `null` when there's no summary yet (other modes, or a
   * compact session before the first eligible compaction). Never mutated
   * directly except by those two methods.
   */
  private summary: SummaryState | null = null;
  /**
   * Prompt-token count of the most recent LLM request, captured from the last
   * `runStream` usage report. Used by the compact-mode threshold trigger to
   * decide whether to summarize this turn: if the ratio of this over
   * CONTEXT_WINDOW exceeds COMPACT_THRESHOLD, fold older turns. Seeded from
   * `AgentOptions.lastPromptTokens` (host restores it from Session.usage on
   * resume) so a freshly-loaded large session compacts on its first turn too.
   */
  private lastPromptTokens = 0;
  /**
   * Last `summary.upToIndex` a mid-turn fold produced, used to dedupe: once a
   * fold pass leaves `upToIndex` unchanged (nothing more to fold), we skip the
   * extra LLM summary call on subsequent iterations that are still over
   * threshold. Reset to -1 at the start of every turn. Avoids a wasteful
   * "summarize the same region every iteration" loop when the current turn's
   * remaining tool results are larger than the headroom even after folding.
   */
  private lastMidTurnFoldUpTo = -1;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.model = opts.model ?? opts.provider.defaultModel;
    this.maxIterations = opts.maxIterations ?? 16;
    this.requestDelayMs = opts.requestDelayMs ?? 0;
    this.contextOpt = opts.contextOptimize ?? DEFAULT_OPTIMIZE_CONFIG;
    // Compact-mode tuning: explicit config wins, else env fallback (CLI/TG),
    // else module default. Resolved once at construction so a host can change
    // the value via settings without touching env vars.
    this.contextWindow =
      this.contextOpt.contextWindow ??
      envInt(process.env, "SIBERFLOW_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW);
    this.compactThreshold =
      this.contextOpt.compactThreshold ??
      (() => {
        const raw = process.env.SIBERFLOW_COMPACT_THRESHOLD;
        if (raw === undefined) return DEFAULT_COMPACT_THRESHOLD;
        const n = Number.parseFloat(raw);
        return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_COMPACT_THRESHOLD;
      })();
    this.compactKeepRecent =
      this.contextOpt.compactKeepRecent ??
      (() => {
        const raw = process.env.SIBERFLOW_COMPACT_KEEP_RECENT;
        if (raw === undefined) return DEFAULT_COMPACT_KEEP_RECENT;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COMPACT_KEEP_RECENT;
      })();
    this.lastPromptTokens = opts.lastPromptTokens ?? 0;
    this.tasksEnabled = opts.tasksEnabled ?? false;
    this.autoContinue = opts.autoContinue ?? true;
    this.subagentMaxIterations = opts.subagentMaxIterations ?? this.maxIterations;
    this.ctx = {
      projectDir: opts.projectDir ?? process.cwd(),
      ...(this.tasksEnabled ? { taskStore: this.taskStore } : {}),
      ...(opts.uploadDir ? { uploadDir: opts.uploadDir } : {}),
      ...(opts.askUser ? { askUser: opts.askUser } : {}),
      ...(opts.botScript ? { botScript: opts.botScript } : {}),
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      ...(opts.imageAccessLogger ? { imageAccessLogger: opts.imageAccessLogger } : {}),
      ...(opts.preTruncate !== undefined ? { preTruncate: opts.preTruncate } : {}),
      // Forward subagent progress to the host UI. The closure captures `this`
      // so it can read the current turn's events at call time.
      subagentProgress: (phase: string, detail?: string) => {
        this.currentEvents?.onSubagentUpdate?.(phase, detail);
      },
    };

    if (opts.systemPrompt) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }
  }

  getTasks(): readonly Task[] {
    return this.taskStore.get();
  }

  /** Seed the task list (e.g. when restoring a saved session). */
  loadTasks(tasks: readonly Task[]): void {
    this.taskStore.set([...tasks]);
  }

  history(): readonly Message[] {
    return this.messages;
  }

  /** Replace the message history (e.g. when restoring a saved session). */
  loadHistory(messages: readonly Message[]): void {
    this.messages.length = 0;
    for (const m of messages) this.messages.push(m);
  }

  /**
   * Restore the persisted LLM summary (from `Session.summary`). Pass null to
   * clear. Called by hosts after `loadHistory()` so the "compact" mode can
   * continue rolling the summary forward instead of restarting from scratch.
   */
  loadSummary(state: SummaryState | null): void {
    this.summary = state ? { ...state } : null;
  }

  /** Current summary state, or null when none. Hosts persist this with the session. */
  summaryState(): SummaryState | null {
    return this.summary ? { ...this.summary } : null;
  }

  /**
   * Seed the compact-mode threshold trigger with the resumed session's last
   * prompt-token count. Called by hosts after `loadHistory()` (when the agent
   * is built before the session is known) so a large loaded session compacts
   * on its first turn instead of waiting one round-trip to re-measure.
   */
  loadLastPromptTokens(n: number): void {
    this.lastPromptTokens = Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Drop history but preserve the system prompt that was set at construction. */
  reset(): void {
    const system = this.messages[0]?.role === "system" ? this.messages[0] : null;
    this.messages.length = 0;
    if (system) this.messages.push(system);
  }

  /**
   * Rewind history back to (and including) the last user message, returning
   * that user message's text. Everything AFTER the last user message is
   * discarded — the assistant's response, any tool calls, and tool results
   * for that turn. This cleanly drops dangling tool_calls (which would
   * otherwise break the next request). The system prompt and all earlier
   * turns are preserved. Returns null if there is no user message in history.
   *
   * Used by "regenerate" (re-send the same prompt) and "edit" (replace the
   * prompt) flows: rewind, optionally swap in a new prompt, then send().
   */
  rewindToLastUserMessage(): string | null {
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return null;
    const text = this.messages[lastUserIdx]!.content;
    // Truncate to just before the last user message so send() re-appends it.
    this.messages.length = lastUserIdx;
    return text;
  }

  async send(userInput: string, events: AgentEvents = {}): Promise<string> {
    const baseMessageCount = this.messages.length;
    const baseTasks = this.taskStore.get().map((t) => ({ ...t }));
    this.currentEvents = events;
    // Reset the per-turn consecutive run_browser counter so a new user turn
    // starts fresh (the Agent instance is reused across turns in long-lived
    // hosts like Telegram, so without this the streak would carry over).
    this.consecutiveRunBrowserCount = 0;
    // Reset the mid-turn fold dedupe gate so a fresh turn can fold again.
    this.lastMidTurnFoldUpTo = -1;
    this.messages.push({ role: "user", content: userInput });

    try {
      throwIfAborted(events.signal);

      const toolSchemas = this.registry.list().map(toSchema);

      // Layer 2 — when "compact" mode is active, roll the LLM narrative summary
      // forward BEFORE deterministic optimization runs. This is the only place
      // that makes an extra LLM call for summarization; it folds any newly
      // completed turns into the existing summary. No-op for other modes and
      // when there's nothing new to summarize. Failures are swallowed so a
      // summarization glitch never breaks the user's turn.
      await this.generateSummaryIncremental(events).catch((err) => {
        if (isAbortError(err) || events.signal?.aborted) throw err;
        debug(`compact summary generation failed (continuing with prior state): ${err}`);
      });

      // Optimize ONCE per user turn — snapshot includes the new user message
      // but excludes tool results produced during this turn's loop below.
      // That keeps the in-progress task's context intact while still
      // truncating older turns' tool results.
      let snapshotEndIndex = this.messages.length;
      let { messages: optimizedBase, stats: optStats } = optimizeContext(
        this.messages,
        this.contextOpt,
        this.summary,
      );
      if (this.contextOpt.enabled && optStats.collapsedCount > 0) {
        events.onContextOptimized?.(optStats);
      }

      for (let i = 0; i < this.maxIterations; i++) {
        throwIfAborted(events.signal);
        events.onAssistantStart?.();

        // Per-iteration request = locked snapshot + anything appended during
        // this turn (current-turn assistant messages and tool results).
        const extras = this.messages.slice(snapshotEndIndex);
        const base =
          extras.length === 0 ? optimizedBase : [...optimizedBase, ...extras];
        // Re-inject current task list each iteration so the model always sees
        // authoritative state (survives context optimization, reflects updates
        // the model just made via task_update mid-turn).
        const requestMessages = this.withTasks(base);

        let { assistant, finishReason, usage } = await this.runStream(
          requestMessages,
          toolSchemas,
          events,
        );

        // Auto-continue a text response that was cut off by max output tokens.
        // The continuation request is ephemeral (partial + nudge); only the
        // merged assistant message is kept in history.
        let continues = 0;
        while (
          this.autoContinue &&
          finishReason === "length" &&
          !assistant.toolCalls?.length &&
          continues < MAX_AUTO_CONTINUES
        ) {
          throwIfAborted(events.signal);
          continues++;
          debug(
            `↻ auto-continue ${continues}/${MAX_AUTO_CONTINUES} (output cut off at length)`,
          );
          const contMessages: Message[] = [
            ...requestMessages,
            // Never send empty/null assistant content to the API (rejected by
            // strict OpenAI-compatible servers). Fall back to a space.
            { role: "assistant", content: assistant.content && assistant.content.length > 0 ? assistant.content : " " },
            { role: "user", content: CONTINUE_NUDGE },
          ];
          const cont = await this.runStream(contMessages, toolSchemas, events);
          assistant = {
            role: "assistant",
            content: (assistant.content ?? "") + (cont.assistant.content ?? ""),
            ...(cont.assistant.toolCalls?.length
              ? { toolCalls: cont.assistant.toolCalls }
              : {}),
          };
          finishReason = cont.finishReason;
          usage = cont.usage;
        }

        throwIfAborted(events.signal);
        this.messages.push(assistant);
        // Track the latest prompt-token count for the compact-mode threshold
        // trigger. The LAST successful iteration's prompt size is the best
        // proxy for "how full is context right now" — it reflects the actual
        // request the provider just accepted.
        if (usage?.promptTokens && usage.promptTokens > 0) {
          this.lastPromptTokens = usage.promptTokens;
        }
        debug(
          `iteration ${i}: finishReason=${finishReason}`,
          `toolCalls=${assistant.toolCalls?.length ?? 0} contentLen=${assistant.content?.length ?? 0}`,
        );

        if (finishReason !== "tool_calls" || !assistant.toolCalls?.length) {
          // No tool batch — emit onAssistantEnd now to close the iteration.
          events.onAssistantEnd?.(assistant, {
            finishReason,
            ...(usage ? { usage } : {}),
          });
          return assistant.content ?? "";
        }

        // Signal a parallel tool-call batch so hosts can render the calls as
        // one collapsible group card. Only emitted for 2+ calls — a single
        // call is rendered as a normal standalone tool block. Balanced by
        // onToolBatchEnd after the loop, even on early return paths below.
        //
        // IMPORTANT: this is emitted BEFORE onAssistantEnd on purpose. Hosts
        // use onAssistantEnd/iteration_end to close the current assistant DOM
        // element, so the batch-open signal must arrive while that element is
        // still the active one — otherwise the group card has nowhere to adopt
        // the tool blocks that streaming already created inside it.
        const batchCount = assistant.toolCalls.length;
        if (batchCount >= 2) {
          events.onToolBatchStart?.(batchCount);
        }
        events.onAssistantEnd?.(assistant, {
          finishReason,
          ...(usage ? { usage } : {}),
        });

        for (let idx = 0; idx < assistant.toolCalls.length; idx++) {
          throwIfAborted(events.signal);
          const call = assistant.toolCalls[idx]!;

          // Track consecutive run_browser calls to guard against infinite
          // browsing loops. "Consecutive" is defined across the whole turn:
          // every run_browser call increments the streak; any OTHER tool call
          // in the same message (or a later one) resets it to 0. When the
          // streak exceeds the cap, we do NOT execute the tool — we return an
          // informational string so the model sees the limit and (usually)
          // stops browsing to answer.
          //
          // Note: streak state lives on the Agent instance but is reset at the
          // start of every turn (send()), so it never carries over between
          // independent turns even though the Agent is reused.
          let result: string;
          if (call.name === "run_browser") {
            this.consecutiveRunBrowserCount++;
            // A limit of 0 means disabled — never force a stop.
            if (
              MAX_CONSECUTIVE_RUN_BROWSER > 0 &&
              this.consecutiveRunBrowserCount > MAX_CONSECUTIVE_RUN_BROWSER
            ) {
              debug(
                `⚠ run_browser consecutive limit hit (${this.consecutiveRunBrowserCount}/${MAX_CONSECUTIVE_RUN_BROWSER}) — forcing final answer`,
              );
              // Do NOT execute the tool, and do NOT return the limit message as
              // a normal tool result — the model previously treated it as
              // browser data and kept calling run_browser past the cap. Instead
              // we send ONE final LLM call that forbids any further tool calls
              // and asks for a direct answer, then return that answer as the
              // turn's final text (breaking out of the tool-call loop for good).
              const stopAnswer = await this.forceFinalAnswer(requestMessages, toolSchemas, events, call);
              this.messages.push(stopAnswer.assistant);
              events.onAssistantEnd?.(stopAnswer.assistant, {
                finishReason: stopAnswer.finishReason,
                ...(stopAnswer.usage ? { usage: stopAnswer.usage } : {}),
              });
              // Close the tool-call batch group before this early return so the
              // host UI doesn't leave the group container open.
              if (batchCount >= 2) {
                events.onToolBatchEnd?.();
              }
              return stopAnswer.assistant.content ?? "";
            } else {
              result = await this.registry.execute(
                call.name,
                call.arguments,
                this.ctx,
              );
            }
          } else {
            // Any non-run_browser tool call resets the consecutive streak.
            this.consecutiveRunBrowserCount = 0;
            result = await this.registry.execute(
              call.name,
              call.arguments,
              this.ctx,
            );
          }

          events.onToolResult?.(idx, call.name, result);
          if (this.tasksEnabled && call.name === "task_update") {
            events.onTasksUpdated?.(this.taskStore.get());
          }
          const toolMsg: ToolResultMessage = {
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: result,
          };
          this.messages.push(toolMsg);
          // Pre-truncation: after a write_file/edit_file lands its result,
          // digest the call's content/new_string/old_string argument in the
          // assistant's tool_calls so the full payload doesn't linger in
          // context for all subsequent iterations. The filesystem is the source
          // of truth — the model can re-read the file if it needs the content.
          if (
            this.ctx.preTruncate !== false &&
            (call.name === "write_file" || call.name === "edit_file")
          ) {
            truncateToolCallArgs(this.messages, call.id);
          }
        }

        // Close the tool-call batch group opened above.
        if (batchCount >= 2) {
          events.onToolBatchEnd?.();
        }

        // Mid-turn sliding-window compaction: if context filled up DURING
        // this iteration loop, fold the oldest current-turn tool results
        // into the rolling summary (keep compactKeepRecent sub-turns verbatim)
        // then recompute optimizedBase + advance snapshotEndIndex so the next
        // iteration's request uses the folded view. No-op for non-compact modes
        // and when we're comfortably under threshold. this.messages is never
        // mutated — only this.summary advances, so persistence stays intact.
        if (
          this.contextOpt.enabled &&
          (this.contextOpt.mode ?? "compact") === "compact" &&
          this.contextWindow > 0 &&
          this.lastPromptTokens / this.contextWindow >= this.compactThreshold &&
          // Dedupe: once a fold pass made no progress on upToIndex, don't keep
          // firing the extra LLM summary call every subsequent iteration. Only
          // dedupe once at least one fold pass has run (lastMidTurnFoldUpTo
          // !== -1) — otherwise both values are -1 and we'd block the first.
          (this.lastMidTurnFoldUpTo === -1 ||
            this.lastMidTurnFoldUpTo !== (this.summary?.upToIndex ?? -1))
        ) {
          const folded = await this.foldCurrentTurnMidLoop(events, snapshotEndIndex).catch(
            (err) => {
              if (isAbortError(err) || events.signal?.aborted) throw err;
              debug(`📦 mid-turn fold failed (continuing): ${err}`);
              return false;
            },
          );
          this.lastMidTurnFoldUpTo = this.summary?.upToIndex ?? -1;
          if (folded) {
            const next = optimizeContext(this.messages, this.contextOpt, this.summary);
            optimizedBase = next.messages;
            snapshotEndIndex = this.messages.length;
          }
        }
      }

      debug(`✗ hit maxIterations cap (${this.maxIterations}) without final answer`);
      events.onMaxIterations?.(this.maxIterations);
      return `(stopped after ${this.maxIterations} iterations without final answer)`;
    } catch (err) {
      if (isAbortError(err)) {
        this.messages.length = baseMessageCount;
        this.taskStore.set(baseTasks);
        throw createAbortError();
      }
      throw err;
    } finally {
      this.currentEvents = null;
    }
  }

  /** Consume one chatStream call, forwarding events, returning the result. */
  private async runStream(
    messages: Message[],
    toolSchemas: ReturnType<typeof toSchema>[],
    events: AgentEvents,
  ): Promise<{
    assistant: AssistantMessage;
    finishReason: FinishReason;
    usage?: UsageStats;
  }> {
    throwIfAborted(events.signal);
    // Anti-rate-limit: pause briefly before hitting the provider. Every LLM
    // request goes through runStream (initial, auto-continue, tool-call
    // iterations), so a single delay here throttles them all. Respects abort
    // so Stop/Ctrl+C cancels the turn immediately even mid-delay.
    if (this.requestDelayMs > 0) {
      debug(`⏳ delay ${this.requestDelayMs}ms before request`);
      await sleep(this.requestDelayMs, events.signal);
    }

    let assistant: AssistantMessage | null = null;
    let finishReason: FinishReason = "other";
    let usage: UsageStats | undefined;

    try {
      for await (const ev of this.provider.chatStream({
        model: this.model,
        messages,
        tools: toolSchemas,
        signal: events.signal,
      })) {
        throwIfAborted(events.signal);
        switch (ev.type) {
          case "content":
            events.onContent?.(ev.delta);
            break;
          case "tool_call_start":
            events.onToolCallStart?.(ev.index, ev.name);
            break;
          case "tool_call_args":
            events.onToolCallArgs?.(ev.index, ev.delta);
            break;
          case "done":
            assistant = ev.message;
            finishReason = ev.finishReason;
            usage = ev.usage;
            break;
        }
      }
    } catch (err) {
      if (isAbortError(err) || events.signal?.aborted) {
        throw createAbortError();
      }
      throw err;
    }

    if (!assistant) {
      throw new Error("Provider stream ended without a final message");
    }
    return { assistant, finishReason, ...(usage ? { usage } : {}) };
  }

  /**
   * Force the model to produce a FINAL text answer with NO further tool calls,
   * used when the run_browser consecutive limit is hit. We append the original
   * (limited) tool call as a stub tool result, plus a hard-stop user nudge, and
   * call the provider with an EMPTY tools array so the model physically cannot
   * request any tool. Whatever it returns becomes the turn's final text.
   */
  private async forceFinalAnswer(
    requestMessages: Message[],
    _toolSchemas: ReturnType<typeof toSchema>[],
    events: AgentEvents,
    blockedCall: ToolCall,
  ): Promise<{ assistant: AssistantMessage; finishReason: FinishReason; usage?: UsageStats }> {
    const finalMessages: Message[] = [
      ...requestMessages,
      {
        role: "assistant",
        content: null,
        toolCalls: [blockedCall],
      },
      {
        role: "tool",
        toolCallId: blockedCall.id,
        name: blockedCall.name,
        content:
          `run_browser was NOT executed: you have reached the hard limit of ${MAX_CONSECUTIVE_RUN_BROWSER} consecutive calls. ` +
          "No more browsing is allowed in this turn.",
      },
      {
        role: "user",
        content:
          `You have hit the hard limit of ${MAX_CONSECUTIVE_RUN_BROWSER} consecutive run_browser calls in this turn. ` +
          "Do NOT call run_browser (or any other tool) again. You are not allowed any more tool calls. " +
          "Stop browsing immediately and write your FINAL answer to the user now, using only the information you have already gathered. " +
          "If you cannot fully answer, say so plainly and summarize what you did find.",
      },
    ];
    events.onAssistantStart?.();
    const result = await this.runStream(finalMessages, [], events);
    return result;
  }

  /**
   * Append the current task checklist to the leading system message so the
   * model always sees authoritative task state. No-op when tasks are
   * disabled or the list is empty.
   */
  private withTasks(messages: Message[]): Message[] {
    if (!this.tasksEnabled || this.taskStore.size === 0) return messages;
    const block = `\n\n# Active task list (maintain via task_update)\n${renderTaskList(this.taskStore.get())}`;
    const result = [...messages];
    if (result[0]?.role === "system") {
      result[0] = { role: "system", content: result[0].content + block };
    } else {
      result.unshift({ role: "system", content: block.trimStart() });
    }
    return result;
  }

  /**
   * Layer 2 — roll the LLM narrative summary forward for "compact" mode.
   *
   * TRIGGER (threshold-based): only fires when the LAST request's prompt-token
   * count reaches COMPACT_THRESHOLD of CONTEXT_WINDOW (default 80%). This makes
   * compaction adaptive — a heavy turn fills the budget fast and compacts
   * sooner, a light conversation may never compact. The token count is tracked
   * from each `runStream` usage report (and seeded from `AgentOptions` on
   * resume so a freshly-loaded large session compacts immediately).
   *
   * FOLD STRATEGY (when triggered): finds completed turns newer than the
   * summary's current `upToIndex`, excluding the COMPACT_KEEP_RECENT most
   * recent completed turns (those stay verbatim) and the current turn. Makes
   * one `runStream` call with no tools and no UI callbacks to produce an
   * updated narrative, stores it in `this.summary`, fires `onContextCompacted`.
   *
   * No-op for non-compact modes, when under threshold, or when there are no
   * newly-eligible turns. Designed to be awaitable and to throw only on abort
   * — other failures are the caller's responsibility (send() swallows them).
   *
   * Invariants: never mutates `this.messages`; only `this.summary` changes.
   */
  private async generateSummaryIncremental(events: AgentEvents): Promise<void> {
    const mode = this.contextOpt.mode ?? "compact";
    if (mode !== "compact" || !this.contextOpt.enabled) return;

    // THRESHOLD CHECK — adaptive trigger. Compare the last request's prompt
    // size against the configured context window. Skip summarization entirely
    // when we're comfortably under budget (saves an API call per turn). On the
    // very first turn of a fresh session lastPromptTokens is 0, so we naturally
    // skip; on resume it's seeded from Session.usage so large sessions compact.
    const ratio = this.contextWindow > 0 ? this.lastPromptTokens / this.contextWindow : 0;
    if (ratio < this.compactThreshold) {
      debug(
        `📦 compact: under threshold (${this.lastPromptTokens}/${this.contextWindow} = ${(ratio * 100).toFixed(0)}% < ${(this.compactThreshold * 100).toFixed(0)}%) — skip`,
      );
      return;
    }

    // Current user message was pushed by send() just before us, so it's the
    // last message right now. Everything strictly before it is a completed
    // turn eligible to be summarized.
    if (this.messages.length < 2) return; // need at least [system?, user] — nothing completed yet
    const currentUserIdx = this.messages.length - 1;
    const lastEligibleIdx = currentUserIdx - 1;
    if (lastEligibleIdx < 0) return;

    const alreadySummarizedUpTo = this.summary?.upToIndex ?? -1;
    // Keep the compactKeepRecent most recent COMPLETED TURNS verbatim —
    // counted per-turn (a turn = user msg + its assistant/tool activity), NOT
    // per-message. A heavy turn with 5 tool results counts as ONE unit, so we
    // fold whole tool-call chains into the summary rather than leaving them in
    // the verbatim tail.
    const candidate = findTurnBoundaryFromEnd(
      this.messages,
      lastEligibleIdx,
      this.compactKeepRecent,
      alreadySummarizedUpTo,
    );
    // Snap down to a SAFE turn boundary so the verbatim tail we keep doesn't
    // start mid-tool-call-chain (an orphan `tool` result with no preceding
    // `assistant.tool_calls` is rejected by strict providers with HTTP 400).
    const summarizeUpTo = snapToTurnBoundary(
      this.messages,
      candidate,
      alreadySummarizedUpTo,
    );
    // Nothing new to fold in (or no safe boundary was found).
    if (summarizeUpTo <= alreadySummarizedUpTo) return;

    const turnsToSummarize = this.messages.slice(
      alreadySummarizedUpTo + 1,
      summarizeUpTo + 1,
    );
    if (turnsToSummarize.length === 0) return;

    // Build the summarization prompt. The prior summary (if any) is fed back
    // in so the model rolls it forward instead of restarting from scratch.
    const summaryPrompt: Message[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      ...(this.summary
        ? [
            {
              role: "user" as const,
              content: `Previous summary (update and extend it; preserve its key facts):\n${this.summary.text}`,
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
    events.onContextCompacting?.();

    // Internal call: no tools, no UI streaming callbacks — only abort signal.
    // runStream already applies requestDelayMs throttling.
    const { assistant } = await this.runStream(summaryPrompt, [], {
      signal: events.signal,
    });
    const text = (assistant.content ?? "").trim();
    if (text.length === 0) {
      debug("📦 compact: model returned empty summary, keeping prior state");
      return;
    }

    this.summary = {
      text,
      upToIndex: summarizeUpTo,
      updatedAt: new Date().toISOString(),
    };
    events.onContextCompacted?.({
      turnsSummarized: turnsToSummarize.length,
      summaryChars: text.length,
    });
    debug(
      `📦 compact: summary updated (${text.length} chars), covers up to index ${summarizeUpTo}`,
    );
  }

  /**
   * Mid-turn sliding-window fold. When context fills up DURING the iteration
   * loop (not just at send() start), fold the OLDEST tool results of the
   * CURRENT turn into the rolling summary, keeping only the
   * `compactKeepRecent` most recent sub-turns verbatim. Sibling of
   * `generateSummaryIncremental`, but operates on the current-turn region
   * `[snapshotEndIndex .. end]` (which has no `user` messages — only
   * assistant-with-toolCalls + tool results), so it uses sub-turn boundaries.
   *
   * Returns true if a fold happened (caller must recompute optimizedBase +
   * advance snapshotEndIndex); false if nothing was eligible. Never mutates
   * `this.messages` — only advances `this.summary.upToIndex` + text.
   */
  private async foldCurrentTurnMidLoop(
    events: AgentEvents,
    snapshotEndIndex: number,
  ): Promise<boolean> {
    // The current user message sits at snapshotEndIndex - 1; the current-turn
    // region is [snapshotEndIndex .. end]. We can only fold if there are more
    // sub-turns there than we want to keep.
    const floor = snapshotEndIndex - 1; // never fold the current user message
    const alreadySummarizedUpTo = this.summary?.upToIndex ?? -1;
    if (alreadySummarizedUpTo >= floor) {
      debug(
        `📦 mid-turn fold: skip — alreadySummarizedUpTo=${alreadySummarizedUpTo} >= floor=${floor} (snapshotEnd=${snapshotEndIndex}, msgs=${this.messages.length})`,
      );
      return false;
    }

    const candidate = findSubTurnBoundaryFromEnd(
      this.messages,
      this.messages.length - 1,
      this.compactKeepRecent,
      floor,
    );
    const foldTo = snapToTurnBoundary(this.messages, candidate, floor);
    if (foldTo <= alreadySummarizedUpTo) {
      debug(
        `📦 mid-turn fold: skip — foldTo=${foldTo} <= alreadySummarizedUpTo=${alreadySummarizedUpTo} (candidate=${candidate}, floor=${floor}, keepRecent=${this.compactKeepRecent})`,
      );
      return false;
    }

    const foldRegion = this.messages.slice(alreadySummarizedUpTo + 1, foldTo + 1);
    if (foldRegion.length === 0) {
      debug(`📦 mid-turn fold: skip — empty fold region`);
      return false;
    }

    const summaryPrompt: Message[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      ...(this.summary
        ? [
            {
              role: "user" as const,
              content: `Previous summary (update and extend it; preserve its key facts):\n${this.summary.text}`,
            },
          ]
        : []),
      {
        role: "user",
        content:
          `Conversation turns to summarize (this is the active task in progress; roles: user, assistant, tool):\n\n` +
          serializeTurns(foldRegion),
      },
    ];

    debug(
      `📦 mid-turn fold: summarizing ${foldRegion.length} message(s) [${alreadySummarizedUpTo + 1}..${foldTo}] (sub-turn window = ${this.compactKeepRecent})`,
    );
    events.onContextCompacting?.();

    const { assistant } = await this.runStream(summaryPrompt, [], {
      signal: events.signal,
    });
    const text = (assistant.content ?? "").trim();
    if (text.length === 0) {
      debug("📦 mid-turn fold: model returned empty summary, keeping prior state");
      return false;
    }

    this.summary = {
      text,
      upToIndex: foldTo,
      updatedAt: new Date().toISOString(),
    };
    events.onContextCompacted?.({
      turnsSummarized: foldRegion.length,
      summaryChars: text.length,
    });
    debug(
      `📦 mid-turn fold: summary updated (${text.length} chars), now covers up to index ${foldTo}`,
    );
    return true;
  }
}

/**
 * Pre-truncation threshold for write_file/edit_file argument payloads. When a
 * field exceeds this many characters, it's replaced with a head+tail digest so
 * the model keeps an anchor (what it wrote/edited) without the full payload
 * bloating context for the rest of the turn.
 */
const PRE_TRUNCATE_ARG_CAP = 1000;

/**
 * Find the assistant toolCall matching `toolCallId` in the message history and
 * digest its large text payload fields (`content` for write_file; `old_string`
 * / `new_string` for edit_file) so the full content doesn't linger in context.
 * The filesystem retains the full content; the model can re-read it if needed.
 * Mutates `messages` in place (the assistant tool_calls live there permanently).
 */
function truncateToolCallArgs(messages: Message[], toolCallId: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const tc = m.toolCalls.find((t) => t.id === toolCallId);
    if (!tc) continue;
    try {
      const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
      let changed = false;
      for (const field of ["content", "new_string", "old_string"]) {
        const v = parsed[field];
        if (typeof v === "string" && v.length > PRE_TRUNCATE_ARG_CAP) {
          const head = v.length / 2 > 500 ? v.slice(0, 500) : v.slice(0, Math.floor(v.length / 2));
          const tail = v.length / 2 > 500 ? v.slice(v.length - 300) : "";
          parsed[field] =
            `${head}\n[...truncated ${v.length - head.length - tail.length} chars; full content is on disk...]\n${tail}`;
          changed = true;
        }
      }
      if (changed) {
        tc.arguments = JSON.stringify(parsed);
      }
    } catch {
      // Args weren't valid JSON — leave them untouched.
    }
    return;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const err = new Error("Request aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Promise-based delay that can be cancelled mid-flight via an AbortSignal.
 * Used to throttle LLM requests (anti rate-limit) without blocking Stop /
 * Ctrl+C: if the user aborts while we're sleeping, the promise rejects with
 * an AbortError so the turn rollbacks immediately.
 */
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
