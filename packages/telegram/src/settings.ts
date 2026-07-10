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

  // ── Multimodal (analyze_image) override ──
  /** false = analyze_image uses env (SIBERFLOW_MULTIMODAL_*); true = fields below. */
  multimodalEnabled: boolean;
  /** Multimodal API key. */
  multimodalApiKey: string;
  /** Multimodal model id (e.g. gpt-4o-mini). */
  multimodalModel: string;
  /** Multimodal API root (e.g. https://api.openai.com/v1). */
  multimodalBaseUrl: string;
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
    multimodalEnabled: false,
    multimodalApiKey: "",
    multimodalModel: "",
    multimodalBaseUrl: "",
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

// ─────────────────────────────────────────────────────────────────────────────
// Image generator presets
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS_FILE = join(homedir(), ".siberflow", "telegram-image-presets.json");

/**
 * A saved image-gen provider configuration that can be loaded back into the
 * panel. Stored separately from the active settings so presets survive even
 * when the active override is disabled. The API key is stored in full here
 * (the file is local, same as the settings file).
 */
export interface ImageGenPreset {
  /** Unique id (slugified name + timestamp). */
  id: string;
  /** User-chosen label, e.g. "OpenAI Production". */
  name: string;
  /** Provider name: openai | deepinfra | novita | qwen | grok. */
  provider: string;
  /** API key (stored in full, local file). */
  apiKey: string;
  /** Model id. */
  model: string;
  /** API root. */
  baseUrl: string;
  /** ISO timestamp of creation/update. */
  updatedAt: string;
}

/** Load all saved presets. Returns [] if the file is missing/corrupt. */
export async function loadImageGenPresets(): Promise<ImageGenPreset[]> {
  try {
    const raw = await readFile(PRESETS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ImageGenPreset[]) : [];
  } catch {
    return [];
  }
}

/** Persist all presets to disk. */
async function persistImageGenPresets(presets: ImageGenPreset[]): Promise<void> {
  await mkdir(dirname(PRESETS_FILE), { recursive: true });
  await writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2), "utf8");
}

/** Generate a stable id from a name. */
function presetId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "preset"}-${Date.now().toString(36)}`;
}

/** Save (create or update by id) a preset and return the updated list. */
export async function saveImageGenPreset(
  preset: Omit<ImageGenPreset, "id" | "updatedAt"> & { id?: string },
): Promise<ImageGenPreset[]> {
  const presets = await loadImageGenPresets();
  const now = new Date().toISOString();
  const existingIdx = preset.id
    ? presets.findIndex((p) => p.id === preset.id)
    : presets.findIndex((p) => p.name === preset.name);
  if (existingIdx !== -1) {
    // Update existing preset (keep the same id).
    presets[existingIdx] = {
      ...presets[existingIdx]!,
      ...preset,
      id: presets[existingIdx]!.id,
      updatedAt: now,
    };
  } else {
    presets.push({
      id: presetId(preset.name),
      name: preset.name,
      provider: preset.provider,
      apiKey: preset.apiKey,
      model: preset.model,
      baseUrl: preset.baseUrl,
      updatedAt: now,
    });
  }
  await persistImageGenPresets(presets);
  return presets;
}

/** Delete a preset by id and return the updated list. */
export async function deleteImageGenPreset(id: string): Promise<ImageGenPreset[]> {
  const presets = await loadImageGenPresets();
  const filtered = presets.filter((p) => p.id !== id);
  await persistImageGenPresets(filtered);
  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main provider presets
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_PRESETS_FILE = join(homedir(), ".siberflow", "telegram-main-presets.json");

/**
 * A saved main (chat) provider configuration. Mirrors {@link ImageGenPreset}
 * but for the main LLM provider (custom OpenAI-compatible). The fields map to
 * the "Override Provider" section of the AI Settings panel.
 */
export interface MainProviderPreset {
  /** Unique id (slugified name + timestamp). */
  id: string;
  /** User-chosen label, e.g. "DeepSeek Production". */
  name: string;
  /** Custom provider display/internal name. */
  customProviderName: string;
  /** Model provider API root (e.g. https://api.example.com/v1). */
  baseUrl: string;
  /** API key for the model provider. */
  apiKey: string;
  /** Default model used for the custom provider. */
  customDefaultModel: string;
  /** ISO timestamp of creation/update. */
  updatedAt: string;
}

/** Load all saved main-provider presets. Returns [] if missing/corrupt. */
export async function loadMainPresets(): Promise<MainProviderPreset[]> {
  try {
    const raw = await readFile(MAIN_PRESETS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MainProviderPreset[]) : [];
  } catch {
    return [];
  }
}

/** Persist all main-provider presets to disk. */
async function persistMainPresets(presets: MainProviderPreset[]): Promise<void> {
  await mkdir(dirname(MAIN_PRESETS_FILE), { recursive: true });
  await writeFile(MAIN_PRESETS_FILE, JSON.stringify(presets, null, 2), "utf8");
}

/** Save (create or update by id/name) a main-provider preset. Returns the list. */
export async function saveMainPreset(
  preset: Omit<MainProviderPreset, "id" | "updatedAt"> & { id?: string },
): Promise<MainProviderPreset[]> {
  const presets = await loadMainPresets();
  const now = new Date().toISOString();
  const existingIdx = preset.id
    ? presets.findIndex((p) => p.id === preset.id)
    : presets.findIndex((p) => p.name === preset.name);
  if (existingIdx !== -1) {
    presets[existingIdx] = {
      ...presets[existingIdx]!,
      ...preset,
      id: presets[existingIdx]!.id,
      updatedAt: now,
    };
  } else {
    presets.push({
      id: presetId(preset.name),
      name: preset.name,
      customProviderName: preset.customProviderName,
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      customDefaultModel: preset.customDefaultModel,
      updatedAt: now,
    });
  }
  await persistMainPresets(presets);
  return presets;
}

/** Delete a main-provider preset by id and return the updated list. */
export async function deleteMainPreset(id: string): Promise<MainProviderPreset[]> {
  const presets = await loadMainPresets();
  const filtered = presets.filter((p) => p.id !== id);
  await persistMainPresets(filtered);
  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multimodal (analyze_image) presets
// ─────────────────────────────────────────────────────────────────────────────

const MULTIMODAL_PRESETS_FILE = join(homedir(), ".siberflow", "telegram-multimodal-presets.json");

/**
 * A saved multimodal (analyze_image) provider configuration. OpenAI-compatible
 * (base URL + API key + model), same shape as the other preset stores.
 */
export interface MultimodalPreset {
  id: string;
  name: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  updatedAt: string;
}

/** Load all saved multimodal presets. Returns [] if missing/corrupt. */
export async function loadMultimodalPresets(): Promise<MultimodalPreset[]> {
  try {
    const raw = await readFile(MULTIMODAL_PRESETS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MultimodalPreset[]) : [];
  } catch {
    return [];
  }
}

/** Persist all multimodal presets to disk. */
async function persistMultimodalPresets(presets: MultimodalPreset[]): Promise<void> {
  await mkdir(dirname(MULTIMODAL_PRESETS_FILE), { recursive: true });
  await writeFile(MULTIMODAL_PRESETS_FILE, JSON.stringify(presets, null, 2), "utf8");
}

/** Save (create or update by id/name) a multimodal preset. Returns the list. */
export async function saveMultimodalPreset(
  preset: Omit<MultimodalPreset, "id" | "updatedAt"> & { id?: string },
): Promise<MultimodalPreset[]> {
  const presets = await loadMultimodalPresets();
  const now = new Date().toISOString();
  const existingIdx = preset.id
    ? presets.findIndex((p) => p.id === preset.id)
    : presets.findIndex((p) => p.name === preset.name);
  if (existingIdx !== -1) {
    presets[existingIdx] = {
      ...presets[existingIdx]!,
      ...preset,
      id: presets[existingIdx]!.id,
      updatedAt: now,
    };
  } else {
    presets.push({
      id: presetId(preset.name),
      name: preset.name,
      apiKey: preset.apiKey,
      model: preset.model,
      baseUrl: preset.baseUrl,
      updatedAt: now,
    });
  }
  await persistMultimodalPresets(presets);
  return presets;
}

/** Delete a multimodal preset by id and return the updated list. */
export async function deleteMultimodalPreset(id: string): Promise<MultimodalPreset[]> {
  const presets = await loadMultimodalPresets();
  const filtered = presets.filter((p) => p.id !== id);
  await persistMultimodalPresets(filtered);
  return filtered;
}
