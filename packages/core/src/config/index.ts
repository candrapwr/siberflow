import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ContextOptimizeConfig, OptimizeMode } from "../agent/optimize.js";
import type { ProviderName } from "../providers/registry.js";
import { DEFAULT_ENABLED_TOOLS } from "../tools/index.js";

export interface SiberflowConfig {
  provider: ProviderName;
  model?: string;
  apiKey: string;
  baseUrl?: string;
  projectDir: string;
  contextOptimize: ContextOptimizeConfig;
  autoContinue: boolean;
  maxIterations: number;
  hideTools: boolean;
  /** Milliseconds to wait before each LLM request (anti rate-limit). 0 = off. */
  requestDelayMs: number;
  /** Tool names to register for the agent. Default: file ops only. */
  enabledTools: Set<string>;
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
    autoContinue: env.SIBERFLOW_AUTO_CONTINUE !== "false",
    maxIterations: resolveMaxIterations(env),
    requestDelayMs: resolveRequestDelay(env),
    enabledTools: resolveEnabledTools(env),
    hideTools: env.SIBERFLOW_HIDE_TOOLS === "true",
    ...(env.SIBERFLOW_MODEL ? { model: env.SIBERFLOW_MODEL } : {}),
    ...(env.SIBERFLOW_BASE_URL ? { baseUrl: env.SIBERFLOW_BASE_URL } : {}),
  };
}

function resolveContextOptimize(env: NodeJS.ProcessEnv): ContextOptimizeConfig {
  // Default ON — context optimization is the baseline behavior. Users who
  // want the raw, unoptimized view set SIBERFLOW_CONTEXT_OPTIMIZE=false.
  const enabled = env.SIBERFLOW_CONTEXT_OPTIMIZE !== "false";
  const mode = resolveOptimizeMode(env);
  // Omit the mode field when it equals the default ("summary") so the
  // serialized config stays minimal; only emit it for the non-default case.
  return { enabled, ...(mode !== "summary" ? { mode } : {}) };
}

function resolveOptimizeMode(env: NodeJS.ProcessEnv): OptimizeMode {
  // Default "summary" (signature breadcrumb). Set SIBERFLOW_CONTEXT_OPTIMIZE_MODE=drop
  // for the more compact drop-everything behavior. Only honored when
  // optimization is enabled; ignored otherwise.
  const raw = env.SIBERFLOW_CONTEXT_OPTIMIZE_MODE?.toLowerCase();
  return raw === "drop" ? "drop" : "summary";
}

function resolveMaxIterations(env: NodeJS.ProcessEnv): number {
  const raw = env.SIBERFLOW_MAX_ITERATIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

/**
 * Delay (ms) before each LLM request — throttles fast tool-call loops so the
 * provider doesn't rate-limit / block. Default 1500 (1.5s). Set
 * `SIBERFLOW_REQUEST_DELAY_MS=0` to disable. Negative/garbage values fall back
 * to the default.
 */
function resolveRequestDelay(env: NodeJS.ProcessEnv): number {
  const raw = env.SIBERFLOW_REQUEST_DELAY_MS;
  if (raw === undefined) return 1500;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1500;
}

/**
 * Which tool names to register for the agent. Default: the five file
 * operations (read/write/edit/copy/list). Set `SIBERFLOW_TOOLS` to a
 * comma-separated list to override, e.g. `read_file,exec,db_query`.
 * `task_update` is never controlled here — it is always registered (it's a
 * built-in tool, not user-toggleable).
 * An empty string yields an empty set (no opt-in tools; task_update still
 * registers).
 */
function resolveEnabledTools(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.SIBERFLOW_TOOLS;
  if (raw === undefined) return new Set(DEFAULT_ENABLED_TOOLS);
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(names);
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
    case "zai":
      return "ZAI_API_KEY";
    case "claude":
      return "ANTHROPIC_API_KEY";
  }
}
