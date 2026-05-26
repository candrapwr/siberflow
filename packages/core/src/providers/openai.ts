import type { ProviderConfig } from "./base.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * OpenAI chat completions.
 *
 * Endpoint: https://api.openai.com/v1
 * Docs: https://platform.openai.com/docs/api-reference/chat
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, {
      name: "openai",
      defaultModel: "gpt-5.4-nano",
      defaultBaseUrl: "https://api.openai.com/v1",
    });
  }
}
