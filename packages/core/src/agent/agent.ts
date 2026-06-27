import type { Provider } from "../providers/base.js";
import type { ToolRegistry, ToolContext } from "../tools/index.js";
import { toSchema } from "../tools/base.js";
import {
  DEFAULT_OPTIMIZE_CONFIG,
  optimizeContext,
  type ContextOptimizeConfig,
  type OptimizationStats,
} from "./optimize.js";
import { TaskStore, renderTaskList, type Task } from "./tasks.js";
import { debug } from "../debug.js";
import type {
  AssistantMessage,
  FinishReason,
  Message,
  ToolResultMessage,
  UsageStats,
} from "./types.js";

const MAX_AUTO_CONTINUES = 4;
const CONTINUE_NUDGE =
  "Your previous message was cut off by the output length limit. Continue from exactly where you stopped — do not repeat anything you already wrote, and do not add a preamble.";

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
  /** Optional context optimization (default: disabled). */
  contextOptimize?: ContextOptimizeConfig;
  /** Enable task checklist injection (the task_update tool must also be registered). */
  tasksEnabled?: boolean;
  /** Auto-continue responses cut off by max output tokens (default: true). */
  autoContinue?: boolean;
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
  /** Fires after the task list changes (task_update tool called). */
  onTasksUpdated?: (tasks: readonly Task[]) => void;
  /** Fires when the turn hit the maxIterations cap without a final answer. */
  onMaxIterations?: (limit: number) => void;
}

export class Agent {
  private readonly provider: Provider;
  private readonly registry: ToolRegistry;
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly requestDelayMs: number;
  private readonly ctx: ToolContext;
  private readonly contextOpt: ContextOptimizeConfig;
  private readonly tasksEnabled: boolean;
  private readonly autoContinue: boolean;
  private readonly taskStore = new TaskStore();
  private readonly messages: Message[] = [];

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.model = opts.model ?? opts.provider.defaultModel;
    this.maxIterations = opts.maxIterations ?? 16;
    this.requestDelayMs = opts.requestDelayMs ?? 0;
    this.contextOpt = opts.contextOptimize ?? DEFAULT_OPTIMIZE_CONFIG;
    this.tasksEnabled = opts.tasksEnabled ?? false;
    this.autoContinue = opts.autoContinue ?? true;
    this.ctx = {
      projectDir: opts.projectDir ?? process.cwd(),
      ...(this.tasksEnabled ? { taskStore: this.taskStore } : {}),
      ...(opts.uploadDir ? { uploadDir: opts.uploadDir } : {}),
      ...(opts.askUser ? { askUser: opts.askUser } : {}),
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
    this.messages.push({ role: "user", content: userInput });

    try {
      throwIfAborted(events.signal);

      const toolSchemas = this.registry.list().map(toSchema);

      // Optimize ONCE per user turn — snapshot includes the new user message
      // but excludes tool results produced during this turn's loop below.
      // That keeps the in-progress task's context intact while still
      // truncating older turns' tool results.
      const snapshotEndIndex = this.messages.length;
      const { messages: optimizedBase, stats: optStats } = optimizeContext(
        this.messages,
        this.contextOpt,
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
        events.onAssistantEnd?.(assistant, {
          finishReason,
          ...(usage ? { usage } : {}),
        });
        debug(
          `iteration ${i}: finishReason=${finishReason}`,
          `toolCalls=${assistant.toolCalls?.length ?? 0} contentLen=${assistant.content?.length ?? 0}`,
        );

        if (finishReason !== "tool_calls" || !assistant.toolCalls?.length) {
          return assistant.content ?? "";
        }

        for (let idx = 0; idx < assistant.toolCalls.length; idx++) {
          throwIfAborted(events.signal);
          const call = assistant.toolCalls[idx]!;
          const result = await this.registry.execute(
            call.name,
            call.arguments,
            this.ctx,
          );
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
