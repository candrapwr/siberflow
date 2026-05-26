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
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${text}`);
    }
    if (!res.body) {
      throw new Error(`${this.name} returned empty response body`);
    }

    let content = "";
    const toolCallsByIndex = new Map<number, ToolCall>();
    const startedIndices = new Set<number>();
    let finishReason: FinishReason = "other";
    let usage: UsageStats | undefined;

    for await (const chunk of parseSSE(res.body)) {
      const data = chunk as StreamChunk;

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
        finishReason = normalizeFinishReason(choice.finish_reason);
      }
    }

    const toolCalls: ToolCall[] = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);

    const message: AssistantMessage = {
      role: "assistant",
      content: content.length > 0 ? content : null,
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
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
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
  if (r === "stop" || r === "tool_calls" || r === "length") return r;
  return "other";
}
