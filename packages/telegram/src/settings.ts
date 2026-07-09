/**
 * Runtime AI provider settings for the Telegram bot.
 *
 * When `enabled`, these override the env-based provider/model/baseUrl/apiKey
 * configuration (SIBERFLOW_TELEGRAM_PROVIDER, SIBERFLOW_TELEGRAM_BASE_URL,
 * SIBERFLOW_TELEGRAM_API_KEY, SIBERFLOW_TELEGRAM_CUSTOM_PROVIDER_NAME,
 * SIBERFLOW_TELEGRAM_CUSTOM_DEFAULT_MODEL). When disabled, the bot falls back
 * to the env-based config loaded at startup.
 *
 * Persisted to ~/.siberflow/telegram-settings.json so the override survives
 * bot restarts. Managed through the admin web service's "AI Settings" panel.
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const SETTINGS_FILE = join(homedir(), ".siberflow", "telegram-settings.json");

export interface TelegramAiSettings {
  /** false = use env config (default); true = use these settings. */
  enabled: boolean;
  /** Provider name to use when enabled. Defaults to "custom". */
  provider: string;
  /** Custom provider display/internal name (custom only). */
  customProviderName: string;
  /** Model provider API root (e.g. https://api.example.com/v1). */
  baseUrl: string;
  /** API key for the model provider. */
  apiKey: string;
  /** Default model used for the custom provider. */
  customDefaultModel: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;

  // ── Image generator override ──
  /** false = image_gen uses env (SIBERFLOW_IMAGE_GEN_*); true = use fields below. */
  imageGenEnabled: boolean;
  /** Image gen provider: openai | deepinfra | novita | qwen | grok. */
  imageGenProvider: string;
  /** Image gen API key. */
  imageGenApiKey: string;
  /** Image gen model id. */
  imageGenModel: string;
  /** Image gen API root. */
  imageGenBaseUrl: string;

  // ── Enabled-tools override ──
  /** false = tool set from env (SIBERFLOW_TELEGRAM_TOOLS); true = use enabledTools. */
  toolsOverride: boolean;
  /** Comma-separated tool names to enable when toolsOverride is true. */
  enabledTools: string;
}

/** Default settings: disabled, empty fields, provider defaults to "custom". */
export function defaultAiSettings(): TelegramAiSettings {
  return {
    enabled: false,
    provider: "custom",
    customProviderName: "",
    baseUrl: "",
    apiKey: "",
    customDefaultModel: "",
    updatedAt: "",
    imageGenEnabled: false,
    imageGenProvider: "openai",
    imageGenApiKey: "",
    imageGenModel: "",
    imageGenBaseUrl: "",
    toolsOverride: false,
    enabledTools: "",
  };
}

/**
 * Load settings from disk, merged over defaults. Returns defaults (enabled:
 * false) if the file is missing or corrupt — never throws.
 */
export async function loadAiSettings(): Promise<TelegramAiSettings> {
  try {
    const raw = await readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<TelegramAiSettings>;
    return { ...defaultAiSettings(), ...parsed };
  } catch {
    return defaultAiSettings();
  }
}

/** Persist settings to disk. Never throws — caller handles errors. */
export async function saveAiSettings(s: TelegramAiSettings): Promise<void> {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(
    SETTINGS_FILE,
    JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

/**
 * Mask an API key for display: show only the last 4 characters, prefixed with
 * asterisks. Used by the GET /api/ai-settings endpoint so the key is never
 * fully exposed in the UI, while still giving a hint of which key is stored.
 */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "****";
  return "*".repeat(Math.min(key.length - 4, 20)) + key.slice(-4);
}

/**
 * When saving settings from the web UI, the API key field may contain a masked
 * value (because GET returns a masked key). If the submitted key looks masked
 * (contains only asterisks + trailing chars), keep the previously-stored key
 * instead of overwriting it with the mask.
 */
export function isMaskedApiKey(key: string): boolean {
  return key.includes("*");
}
