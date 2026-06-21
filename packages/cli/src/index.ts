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
  });
  const registry = createDefaultRegistry({ tasks: config.tasksEnabled });
  const model = config.model ?? provider.defaultModel;

  await runRepl({
    provider,
    registry,
    model,
    projectDir: config.projectDir,
    contextOptimize: config.contextOptimize,
    tasksEnabled: config.tasksEnabled,
    autoContinue: config.autoContinue,
    maxIterations: config.maxIterations,
    requestDelayMs: config.requestDelayMs,
    hideTools: config.hideTools,
  });
}

main().catch((err) => {
  console.error(ui.error((err as Error).message));
  process.exit(1);
});
