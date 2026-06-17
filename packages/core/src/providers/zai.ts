import type { ProviderConfig } from "./base.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * Z.AI GLM models via the OpenAI-compatible chat completions endpoint.
 *
 * General endpoint: https://api.z.ai/api/paas/v4
 * Coding endpoint:  https://api.z.ai/api/coding/paas/v4
 *
 * Defaulting to the general endpoint is the safer baseline for a custom tool.
 * Users who specifically need the coding endpoint can override it via
 * SIBERFLOW_BASE_URL / extension settings.
 *
 * Docs:
 * - https://docs.z.ai/guides/overview/quick-start
 * - https://docs.z.ai/guides/capabilities/function-calling
 */
export class ZaiProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, {
      name: "zai",
      defaultModel: "glm-5.2",
      defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    });
  }

  protected requestBodyExtras(): Record<string, unknown> {
    return { tool_stream: true };
  }
}
