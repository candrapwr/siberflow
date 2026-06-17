import { DeepSeekProvider } from "./deepseek.js";
import { GeminiProvider } from "./gemini.js";
import { GrokProvider } from "./grok.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import { QwenProvider } from "./qwen.js";
import { ZaiProvider } from "./zai.js";
import { ClaudeProvider } from "./claude.js";
import type { Provider, ProviderConfig } from "./base.js";

export type ProviderName =
  | "deepseek"
  | "gemini"
  | "openai"
  | "openai-responses"
  | "grok"
  | "qwen"
  | "zai"
  | "claude";

export function createProvider(
  name: ProviderName,
  config: ProviderConfig,
): Provider {
  switch (name) {
    case "deepseek":
      return new DeepSeekProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "openai-responses":
      return new OpenAIResponsesProvider(config);
    case "grok":
      return new GrokProvider(config);
    case "qwen":
      return new QwenProvider(config);
    case "zai":
      return new ZaiProvider(config);
    case "claude":
      return new ClaudeProvider(config);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}
