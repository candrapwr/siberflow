import type { ProviderConfig } from "./base.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * Google Gemini via its OpenAI-compatible endpoint.
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/openai/
 * Docs: https://ai.google.dev/gemini-api/docs/openai
 */
export class GeminiProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, {
      name: "gemini",
      defaultModel: "gemini-2.5-flash",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
  }
}
