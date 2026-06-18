// Encrypted API-key storage using Electron's safeStorage (OS keychain-backed).
// Keys are encrypted at rest in userData/siberflow-keys.json.

import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderName } from "@shared/protocol";

interface KeyStore {
  [provider: string]: string; // base64 of encrypted buffer
}

function storePath(): string {
  return join(app.getPath("userData"), "siberflow-keys.json");
}

function readStore(): KeyStore {
  try {
    const raw = readFileSync(storePath(), "utf8");
    return JSON.parse(raw) as KeyStore;
  } catch {
    return {};
  }
}

function writeStore(store: KeyStore): void {
  const dir = dirname(storePath());
  mkdirSync(dir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
}

/** Returns true if safeStorage can encrypt (keychain available / not locked). */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** Read a stored API key for the given provider, or null if absent. */
export function getApiKey(provider: ProviderName): string | null {
  const store = readStore();
  const blob = store[provider];
  if (!blob) return null;
  try {
    const buf = Buffer.from(blob, "base64");
    if (!isEncryptionAvailable()) return null;
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

/** Encrypt and persist an API key for the given provider. */
export function setApiKey(provider: ProviderName, key: string): void {
  if (!isEncryptionAvailable()) {
    throw new Error("OS keychain is unavailable; cannot store API key securely.");
  }
  const store = readStore();
  store[provider] = safeStorage.encryptString(key).toString("base64");
  writeStore(store);
}

/** Remove the stored API key for the given provider. */
export function deleteApiKey(provider: ProviderName): void {
  const store = readStore();
  delete store[provider];
  writeStore(store);
}
