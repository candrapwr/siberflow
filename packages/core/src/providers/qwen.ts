import type { ProviderConfig } from "./base.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

/**
 * Alibaba Cloud Qwen via OpenAI-compatible endpoint (DashScope / Model Studio).
 *
 * Default endpoint: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
 *   (international, for users outside China)
 * China endpoint:   https://dashscope.aliyuncs.com/compatible-mode/v1
 *
 * Users with a dedicated MaaS / Model Studio workspace get their own custom
 * endpoint (e.g. https://llm-<id>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1).
 * Override via SIBERFLOW_BASE_URL or the `siberflow.baseUrl` setting.
 *
 * Docs: https://www.alibabacloud.com/help/en/model-studio/use-qwen-by-calling-api
 */
export class QwenProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super(config, {
      name: "qwen",
      defaultModel: "qwen3.7-plus",
      defaultBaseUrl:
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
  }
}
