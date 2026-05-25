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

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

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

export class DeepSeekProvider implements Provider {
  readonly name = "deepseek";
  readonly defaultModel = "deepseek-chat";

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new Error("DeepSeek provider requires an API key");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body = {
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
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
      throw new Error(`DeepSeek API error ${res.status}: ${text}`);
    }
    if (!res.body) {
      throw new Error("DeepSeek returned empty response body");
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

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload);
          } catch {
            // skip malformed SSE chunk
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
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
