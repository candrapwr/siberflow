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
  customProviderName?: string;
  customDefaultModel?: string;
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
    ...(provider === "custom" && env.SIBERFLOW_CUSTOM_PROVIDER_NAME
      ? { customProviderName: env.SIBERFLOW_CUSTOM_PROVIDER_NAME }
      : {}),
    ...(provider === "custom"
      ? {
          customDefaultModel:
            env.SIBERFLOW_CUSTOM_DEFAULT_MODEL ?? env.SIBERFLOW_MODEL ?? "",
        }
      : {}),
  };
}

function resolveContextOptimize(env: NodeJS.ProcessEnv): ContextOptimizeConfig {
  // Default ON — context optimization is the baseline behavior. Users who
  // want the raw, unoptimized view set SIBERFLOW_CONTEXT_OPTIMIZE=false.
  const enabled = env.SIBERFLOW_CONTEXT_OPTIMIZE !== "false";
  const mode = resolveOptimizeMode(env);
  // Omit the mode field when it equals the default ("compact") so the
  // serialized config stays minimal; only emit it for the non-default case.
  return {
    enabled,
    ...(mode !== "compact" ? { mode } : {}),
    // Compact-mode tuning (only surfaced to the agent when set). CLI/Telegram
    // path; Desktop/VSCode construct ContextOptimizeConfig directly with these
    // fields from their settings UI.
    ...(env.SIBERFLOW_CONTEXT_WINDOW
      ? { contextWindow: parseEnvInt(env.SIBERFLOW_CONTEXT_WINDOW) }
      : {}),
    ...(env.SIBERFLOW_COMPACT_THRESHOLD
      ? { compactThreshold: parseEnvFloat(env.SIBERFLOW_COMPACT_THRESHOLD) }
      : {}),
    ...(env.SIBERFLOW_COMPACT_KEEP_RECENT
      ? { compactKeepRecent: parseEnvInt(env.SIBERFLOW_COMPACT_KEEP_RECENT) }
      : {}),
  };
}

function parseEnvInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined as unknown as number;
}
function parseEnvFloat(raw: string): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined as unknown as number;
}

function resolveOptimizeMode(env: NodeJS.ProcessEnv): OptimizeMode {
  // Default "compact" — LLM-generated narrative summary of old turns (Layer 2).
  // Richest context retention; threshold-triggered so it only fires when
  // context fills up. Other modes:
  //   "recent"  — signature breadcrumb, keep the most recent completed turn
  //               intact (compress only older turns).
  //   "summary" — signature breadcrumb on ALL past turns.
  //   "drop"    — drop-everything behavior (no breadcrumb).
  // Only honored when optimization is enabled; ignored otherwise.
  const raw = env.SIBERFLOW_CONTEXT_OPTIMIZE_MODE?.toLowerCase();
  if (raw === "drop") return "drop";
  if (raw === "summary") return "summary";
  if (raw === "recent") return "recent";
  return "compact";
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
    case "custom":
      return "CUSTOM_API_KEY";
  }
}
