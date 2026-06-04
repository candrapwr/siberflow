import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ContextOptimizeConfig } from "../agent/optimize.js";
import type { ProviderName } from "../providers/registry.js";

export interface SiberflowConfig {
  provider: ProviderName;
  model?: string;
  apiKey: string;
  baseUrl?: string;
  projectDir: string;
  contextOptimize: ContextOptimizeConfig;
  tasksEnabled: boolean;
  autoContinue: boolean;
  maxIterations: number;
  hideTools: boolean;
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SiberflowConfig {
  const provider = (env.SIBERFLOW_PROVIDER ?? "deepseek") as ProviderName;

  const apiKey = resolveApiKey(provider, env);
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${provider}". Set ${apiKeyEnvVar(provider)}.`,
    );
  }

  return {
    provider,
    apiKey,
    projectDir: resolveProjectDir(env),
    contextOptimize: resolveContextOptimize(env),
    tasksEnabled: env.SIBERFLOW_TASKS === "true",
    autoContinue: env.SIBERFLOW_AUTO_CONTINUE !== "false",
    maxIterations: resolveMaxIterations(env),
    hideTools: env.SIBERFLOW_HIDE_TOOLS === "true",
    ...(env.SIBERFLOW_MODEL ? { model: env.SIBERFLOW_MODEL } : {}),
    ...(env.SIBERFLOW_BASE_URL ? { baseUrl: env.SIBERFLOW_BASE_URL } : {}),
  };
}

function resolveContextOptimize(env: NodeJS.ProcessEnv): ContextOptimizeConfig {
  return { enabled: env.SIBERFLOW_CONTEXT_OPTIMIZE === "true" };
}

function resolveMaxIterations(env: NodeJS.ProcessEnv): number {
  const raw = env.SIBERFLOW_MAX_ITERATIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

function resolveProjectDir(env: NodeJS.ProcessEnv): string {
  const fallback = env.INIT_CWD ?? process.cwd();
  const raw = env.SIBERFLOW_PROJECT_DIR;
  if (!raw) return fallback;

  const expanded = expandHome(raw);
  const abs = isAbsolute(expanded) ? expanded : resolve(fallback, expanded);

  try {
    const stat = statSync(abs);
    if (!stat.isDirectory()) {
      throw new Error(`SIBERFLOW_PROJECT_DIR is not a directory: ${abs}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`SIBERFLOW_PROJECT_DIR does not exist: ${abs}`);
    }
    throw err;
  }

  return abs;
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) return p === "~" ? home : resolve(home, p.slice(2));
  }
  return p;
}

function resolveApiKey(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return env[apiKeyEnvVar(provider)];
}

function apiKeyEnvVar(provider: ProviderName): string {
  switch (provider) {
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "openai":
    case "openai-responses":
      return "OPENAI_API_KEY";
    case "grok":
      return "XAI_API_KEY";
    case "qwen":
      return "DASHSCOPE_API_KEY";
  }
}
