export type Role = "system" | "user" | "assistant" | "tool";

export interface TextMessage {
  role: "system" | "user";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type Message = TextMessage | AssistantMessage | ToolResultMessage;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
}

export type StreamEvent =
  | { type: "content"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | {
      type: "done";
      message: AssistantMessage;
      finishReason: FinishReason;
      usage?: UsageStats;
    };
