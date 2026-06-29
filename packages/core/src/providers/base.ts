import type { ChatRequest, StreamEvent } from "../agent/types.js";

export interface Provider {
  readonly name: string;
  readonly defaultModel: string;
  chatStream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  customName?: string;
  customDefaultModel?: string;
}
