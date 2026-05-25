import { DeepSeekProvider } from "./deepseek.js";
import type { Provider, ProviderConfig } from "./base.js";

export type ProviderName = "deepseek";

export function createProvider(
  name: ProviderName,
  config: ProviderConfig,
): Provider {
  switch (name) {
    case "deepseek":
      return new DeepSeekProvider(config);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}
