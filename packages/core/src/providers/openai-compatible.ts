import type {
  AssistantMessage,
  ChatRequest,
  FinishReason,
  Message,
  StreamEvent,
  ToolCall,
  ToolSchema,
  UsageStats,
} from "../agent/types.js";
import type { Provider, ProviderConfig } from "./base.js";
import { parseSSE } from "./sse.js";
import { debug } from "../debug.js";

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface DeltaToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: Array<{
    delta: {
      content?: string | null;
      tool_calls?: DeltaToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenAICompatibleOptions {
  name: string;
  defaultModel: string;
  defaultBaseUrl: string;
  /**
   * Some upstreams reject `stream_options`. Set to false to omit it
   * (you'll lose token usage stats from the streaming response).
   */
  includeUsageInStream?: boolean;
}

/**
 * Base class for any provider that speaks the OpenAI `/chat/completions`
 * wire format with SSE streaming. DeepSeek and Google Gemini (via its
 * OpenAI-compatible endpoint) both qualify.
 */
export abstract class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  readonly defaultModel: string;

  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly includeUsageInStream: boolean;

  constructor(config: ProviderConfig, opts: OpenAICompatibleOptions) {
    if (!config.apiKey) {
      throw new Error(`${opts.name} provider requires an API key`);
    }
    this.name = opts.name;
    this.defaultModel = opts.defaultModel;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? opts.defaultBaseUrl;
    this.includeUsageInStream = opts.includeUsageInStream ?? true;
  }

  protected requestBodyExtras(): Record<string, unknown> {
    return {};
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      ...(this.includeUsageInStream
        ? { stream_options: { include_usage: true } }
        : {}),
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools.map(toOpenAITool), tool_choice: "auto" }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...this.requestBodyExtras(),
    };

    debug(
      `→ ${this.name} POST /chat/completions model=${req.model}`,
      `msgs=${req.messages.length} tools=${req.tools?.length ?? 0}`,
    );

    const requestBody = JSON.stringify(body);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: requestBody,
      signal: req.signal,
    });

    debug(`← ${this.name} HTTP ${res.status} ${res.statusText}`);

    if (!res.ok) {
      const text = await res.text();
      debug(`✗ ${this.name} error body:`, text);
      const err = new Error(`${this.name} API error ${res.status}: ${text}`);
      (err as { requestBody?: string }).requestBody = requestBody;
      throw err;
    }
    if (!res.body) {
      const err = new Error(`${this.name} returned empty response body`);
      (err as { requestBody?: string }).requestBody = requestBody;
      throw err;
    }

    let content = "";
    const toolCallsByIndex = new Map<number, ToolCall>();
    const startedIndices = new Set<number>();
    let finishReason: FinishReason = "other";
    let rawFinish: string | null = null;
    let usage: UsageStats | undefined;
    let chunkCount = 0;

    for await (const chunk of parseSSE(res.body)) {
      const data = chunk as StreamChunk;
      chunkCount++;

      if (data.usage) {
        usage = {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
        };
      }

      const choice = data.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        yield { type: "content", delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing =
            toolCallsByIndex.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);

          if (!startedIndices.has(tc.index) && existing.id && existing.name) {
            startedIndices.add(tc.index);
            yield {
              type: "tool_call_start",
              index: tc.index,
              id: existing.id,
              name: existing.name,
            };
          }

          if (tc.function?.arguments) {
            yield {
              type: "tool_call_args",
              index: tc.index,
              delta: tc.function.arguments,
            };
          }
        }
      }

      if (choice.finish_reason) {
        rawFinish = choice.finish_reason;
        finishReason = normalizeFinishReason(choice.finish_reason);
      }
    }

    const toolCalls: ToolCall[] = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);

    debug(
      `✓ ${this.name} stream done: chunks=${chunkCount}`,
      `finish_reason(raw)=${rawFinish ?? "null"} → ${finishReason}`,
      `contentLen=${content.length} toolCalls=${toolCalls.length}`,
      usage ? `usage=${usage.promptTokens}/${usage.completionTokens}` : "usage=none",
    );
    if (rawFinish === null) {
      debug(
        `⚠ ${this.name} stream ended WITHOUT a finish_reason — likely a dropped/incomplete stream`,
      );
    }

    const message: AssistantMessage = {
      role: "assistant",
      content: content.length > 0 ? content : toolCalls.length > 0 ? null : " ",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    yield {
      type: "done",
      message,
      finishReason,
      ...(usage ? { usage } : {}),
    };
  }
}

function toOpenAIMessage(m: Message): OpenAIChatMessage {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant": {
      const hasToolCalls = !!(m.toolCalls && m.toolCalls.length > 0);
      return {
        role: "assistant",
        // Belt-and-suspenders: never emit null/empty content without
        // tool_calls — strict OpenAI-compatible servers (DeepSeek, etc.)
        // reject "{role: assistant, content: null}" with a 400.
        content: hasToolCalls
          ? m.content ?? ""
          : m.content && m.content.length > 0
            ? m.content
            : " ",
        ...(hasToolCalls
          ? {
              tool_calls: m.toolCalls!.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
    }
    case "tool":
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId,
        name: m.name,
      };
  }
}

function toOpenAITool(t: ToolSchema) {
  return {
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

function normalizeFinishReason(r: string): FinishReason {
  // Tolerate variants from non-OpenAI providers (Gemini, etc.):
  // case differences and alternate names like MAX_TOKENS / FUNCTION_CALL.
  const v = r.toLowerCase();
  if (v === "stop" || v === "end_turn" || v === "complete") return "stop";
  if (v === "tool_calls" || v === "function_call" || v === "tool_use")
    return "tool_calls";
  if (v === "length" || v === "max_tokens" || v === "model_length")
    return "length";
  return "other";
}
