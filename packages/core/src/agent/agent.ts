import type { Provider } from "../providers/base.js";
import type { ToolRegistry, ToolContext } from "../tools/index.js";
import { toSchema } from "../tools/base.js";
import {
  DEFAULT_OPTIMIZE_CONFIG,
  optimizeContext,
  type ContextOptimizeConfig,
  type OptimizationStats,
} from "./optimize.js";
import type {
  AssistantMessage,
  FinishReason,
  Message,
  ToolResultMessage,
  UsageStats,
} from "./types.js";

export interface AgentOptions {
  provider: Provider;
  registry: ToolRegistry;
  model?: string;
  systemPrompt?: string;
  maxIterations?: number;
  /** Sandbox root that file tools and exec are restricted to. */
  projectDir?: string;
  /** Optional context optimization (default: disabled). */
  contextOptimize?: ContextOptimizeConfig;
}

export interface AgentEvents {
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
}

export class Agent {
  private readonly provider: Provider;
  private readonly registry: ToolRegistry;
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly ctx: ToolContext;
  private readonly contextOpt: ContextOptimizeConfig;
  private readonly messages: Message[] = [];

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.model = opts.model ?? opts.provider.defaultModel;
    this.maxIterations = opts.maxIterations ?? 16;
    this.ctx = { projectDir: opts.projectDir ?? process.cwd() };
    this.contextOpt = opts.contextOptimize ?? DEFAULT_OPTIMIZE_CONFIG;

    if (opts.systemPrompt) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }
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

  async send(userInput: string, events: AgentEvents = {}): Promise<string> {
    this.messages.push({ role: "user", content: userInput });

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
      events.onAssistantStart?.();

      let assistant: AssistantMessage | null = null;
      let finishReason: FinishReason = "other";
      let usage: UsageStats | undefined;

      // Per-iteration request = locked snapshot + anything appended during
      // this turn (current-turn assistant messages and tool results).
      const extras = this.messages.slice(snapshotEndIndex);
      const requestMessages =
        extras.length === 0 ? optimizedBase : [...optimizedBase, ...extras];

      for await (const ev of this.provider.chatStream({
        model: this.model,
        messages: requestMessages,
        tools: toolSchemas,
      })) {
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

      if (!assistant) {
        throw new Error("Provider stream ended without a final message");
      }

      this.messages.push(assistant);
      events.onAssistantEnd?.(assistant, {
        finishReason,
        ...(usage ? { usage } : {}),
      });

      if (finishReason !== "tool_calls" || !assistant.toolCalls?.length) {
        return assistant.content ?? "";
      }

      for (let idx = 0; idx < assistant.toolCalls.length; idx++) {
        const call = assistant.toolCalls[idx]!;
        const result = await this.registry.execute(
          call.name,
          call.arguments,
          this.ctx,
        );
        events.onToolResult?.(idx, call.name, result);
        const toolMsg: ToolResultMessage = {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: result,
        };
        this.messages.push(toolMsg);
      }
    }

    return `(stopped after ${this.maxIterations} iterations without final answer)`;
  }
}
