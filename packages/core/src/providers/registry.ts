import { DeepSeekProvider } from "./deepseek.js";
import { GeminiProvider } from "./gemini.js";
import { GrokProvider } from "./grok.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import { QwenProvider } from "./qwen.js";
import { ZaiProvider } from "./zai.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider, ProviderConfig } from "./base.js";

export type ProviderName =
  | "deepseek"
  | "gemini"
  | "openai"
  | "openai-responses"
  | "grok"
  | "qwen"
  | "zai"
  | "claude"
  | "custom";

class CustomProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    const name = config.customName?.trim() || "custom";
    const defaultModel = config.customDefaultModel?.trim();
    if (!defaultModel) {
      throw new Error("Custom provider requires a default model.");
    }
    if (!config.baseUrl?.trim()) {
      throw new Error("Custom provider requires a base URL.");
    }
    super(
      { ...config, baseUrl: config.baseUrl.trim() },
      {
        name,
        defaultModel,
        defaultBaseUrl: config.baseUrl.trim(),
      },
    );
  }
}

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
    case "custom":
      return new CustomProvider(config);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}
