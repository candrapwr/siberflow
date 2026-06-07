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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI Responses API (`/v1/responses`). Required by models that no longer
 * accept `/v1/chat/completions` (codex variants, some o-series and gpt-5).
 *
 * Differences from chat completions:
 *   - `input` (array of items) instead of `messages`
 *   - Tool calls split into `function_call` items + `function_call_output`
 *   - Streaming uses `response.*` SSE event types
 *   - `tools` schema is flat (no nested `function` wrapper)
 *
 * Docs: https://platform.openai.com/docs/api-reference/responses
 */
export class OpenAIResponsesProvider implements Provider {
  readonly name = "openai-responses";
  readonly defaultModel = "gpt-5.1-codex-mini";

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new Error("openai-responses provider requires an API key");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const input = req.messages.flatMap(toInputItems);

    const body = {
      model: req.model,
      input,
      stream: true,
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools.map(toResponseTool) }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_output_tokens: req.maxTokens } : {}),
    };

    debug(
      `→ openai-responses POST /responses model=${req.model}`,
      `input=${input.length} tools=${req.tools?.length ?? 0}`,
    );

    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    debug(`← openai-responses HTTP ${res.status} ${res.statusText}`);

    if (!res.ok) {
      const text = await res.text();
      debug(`✗ openai-responses error body:`, text);
      throw new Error(`openai-responses API error ${res.status}: ${text}`);
    }
    if (!res.body) {
      throw new Error("openai-responses returned empty response body");
    }

    interface PendingCall {
      callId: string;
      name: string;
      arguments: string;
      index: number;
    }

    const callsByItemId = new Map<string, PendingCall>();
    let nextIndex = 0;
    let content = "";
    let finishReason: FinishReason = "other";
    let usage: UsageStats | undefined;

    for await (const chunk of parseSSE(res.body)) {
      const ev = chunk as ResponsesEvent;

      switch (ev.type) {
        case "response.output_text.delta": {
          const d = ev.delta ?? "";
          if (d.length > 0) {
            content += d;
            yield { type: "content", delta: d };
          }
          break;
        }

        case "response.output_item.added": {
          const item = ev.item;
          if (
            item?.type === "function_call" &&
            typeof item.id === "string" &&
            typeof item.name === "string"
          ) {
            const callId = item.call_id ?? item.id;
            const pending: PendingCall = {
              callId,
              name: item.name,
              arguments: "",
              index: nextIndex++,
            };
            callsByItemId.set(item.id, pending);
            yield {
              type: "tool_call_start",
              index: pending.index,
              id: callId,
              name: item.name,
            };
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const itemId = ev.item_id;
          const d = ev.delta ?? "";
          if (!itemId || d.length === 0) break;
          const pending = callsByItemId.get(itemId);
          if (!pending) break;
          pending.arguments += d;
          yield { type: "tool_call_args", index: pending.index, delta: d };
          break;
        }

        case "response.completed": {
          const resp = ev.response;
          if (resp?.usage) {
            usage = {
              promptTokens: resp.usage.input_tokens ?? 0,
              completionTokens: resp.usage.output_tokens ?? 0,
            };
          }
          finishReason = callsByItemId.size > 0 ? "tool_calls" : "stop";
          break;
        }

        case "response.incomplete": {
          finishReason = "length";
          break;
        }

        case "response.failed":
        case "error": {
          const msg =
            ev.response?.error?.message ??
            (ev as { message?: string }).message ??
            "unknown stream error";
          throw new Error(`openai-responses stream error: ${msg}`);
        }
      }
    }

    const toolCalls: ToolCall[] = [...callsByItemId.values()]
      .sort((a, b) => a.index - b.index)
      .map((p) => ({ id: p.callId, name: p.name, arguments: p.arguments }));

    debug(
      `✓ openai-responses stream done: finishReason=${finishReason}`,
      `contentLen=${content.length} toolCalls=${toolCalls.length}`,
      usage ? `usage=${usage.promptTokens}/${usage.completionTokens}` : "usage=none",
    );

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

// ---------- conversions ----------

type ResponseInputItem =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | { type: "function_call_output"; call_id: string; output: string };

function toInputItems(m: Message): ResponseInputItem[] {
  switch (m.role) {
    case "system":
    case "user":
      return [{ role: m.role, content: m.content }];
    case "assistant": {
      const items: ResponseInputItem[] = [];
      if (m.content !== null && m.content.length > 0) {
        items.push({ role: "assistant", content: m.content });
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          items.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
      }
      return items;
    }
    case "tool":
      return [
        {
          type: "function_call_output",
          call_id: m.toolCallId,
          output: m.content,
        },
      ];
  }
}

function toResponseTool(t: ToolSchema): {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  };
}

// ---------- SSE event shape ----------

interface ResponsesEvent {
  type: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
  };
  item_id?: string;
  output_index?: number;
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
}
