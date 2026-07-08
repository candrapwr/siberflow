import {
  createDefaultRegistry,
  createProvider,
  loadConfigFromEnv,
} from "@siberflow/core";
import { loadDotEnv } from "./env.js";
import { runRepl } from "./repl.js";
import { ui } from "./ui.js";

async function main(): Promise<void> {
  await loadDotEnv();

  let config;
  try {
    config = loadConfigFromEnv();
  } catch (err) {
    console.error(ui.error((err as Error).message));
    process.exit(1);
  }

  const provider = createProvider(config.provider, {
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.customProviderName
      ? { customName: config.customProviderName }
      : {}),
    ...(config.customDefaultModel
      ? { customDefaultModel: config.customDefaultModel }
      : {}),
  });
  const registry = createDefaultRegistry({
    enabledTools: config.enabledTools,
  });
  const model = config.model ?? provider.defaultModel;

  await runRepl({
    provider,
    registry,
    model,
    projectDir: config.projectDir,
    contextOptimize: config.contextOptimize,
    enabledToolNames: registry.list().map((t) => t.name),
    autoContinue: config.autoContinue,
    preTruncate: config.preTruncate,
    maxIterations: config.maxIterations,
    requestDelayMs: config.requestDelayMs,
    hideTools: config.hideTools,
  });
}

main().catch((err) => {
  console.error(ui.error((err as Error).message));
  process.exit(1);
});
