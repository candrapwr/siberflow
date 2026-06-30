// Settings persistence: a plain JSON file in userData. Mirrors the VSCode-ext
// siberflow.* settings but stored locally for the desktop app.

import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS, type SettingsValues } from "@shared/protocol";

function settingsPath(): string {
  return join(app.getPath("userData"), "siberflow-settings.json");
}

/** Load settings, falling back to defaults on missing/corrupt file. */
export function loadSettings(): SettingsValues {
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SettingsValues>;
    // Merge with defaults so new fields are populated for existing installs.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      customProvider: {
        ...DEFAULT_SETTINGS.customProvider,
        ...(parsed.customProvider ?? {}),
      },
      multimodalProvider: {
        ...DEFAULT_SETTINGS.multimodalProvider,
        ...(parsed.multimodalProvider ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings to disk. */
export function saveSettings(values: SettingsValues): void {
  const dir = dirname(settingsPath());
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(values, null, 2), "utf8");
}
