import type { ProviderConfig } from "./base.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * xAI Grok via its OpenAI-compatible endpoint.
 *
 * Endpoint: https://api.x.ai/v1
 * Docs: https://docs.x.ai/api
 */
export class GrokProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, {
      name: "grok",
      defaultModel: "grok-build-0.1",
      defaultBaseUrl: "https://api.x.ai/v1",
    });
  }
}
