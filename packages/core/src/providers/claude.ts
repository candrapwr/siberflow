import type { ProviderConfig } from "./base.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * Anthropic Claude via its OpenAI-compatible chat completions endpoint.
 *
 * Anthropic exposes a first-party compatibility layer at /v1/chat/completions
 * that speaks the standard OpenAI wire format (Bearer auth, stream_options,
 * tool_calls, usage) — so it slots straight into OpenAICompatibleProvider.
 *
 * Endpoint: https://api.anthropic.com/v1
 * Docs: https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk
 *
 * Note: prompt caching and extended thinking are native Messages-API features
 * and are not surfaced through this compatibility layer.
 */
export class ClaudeProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, {
      name: "claude",
      defaultModel: "claude-sonnet-4-5",
      defaultBaseUrl: "https://api.anthropic.com/v1",
    });
  }
}
