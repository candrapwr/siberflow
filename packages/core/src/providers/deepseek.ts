import type { ProviderConfig } from "./base.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, {
      name: "deepseek",
      defaultModel: "deepseek-chat",
      defaultBaseUrl: "https://api.deepseek.com/v1",
    });
  }
}
