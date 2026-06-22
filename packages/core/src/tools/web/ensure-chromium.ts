// Ensures the Playwright Chromium browser is available locally. Browsers are
// downloaded on first use (not bundled) so the installer stays small. The
// cache lives at the OS-default Playwright path:
//   macOS   ~/Library/Caches/ms-playwright
//   Linux   ~/.cache/ms-playwright
//   Windows %USERPROFILE%\AppData\Local\ms-playwright

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

/** Whether the Chromium build referenced by playwright-core is on disk. */
export function isChromiumInstalled(): boolean {
  try {
    const p = chromium.executablePath();
    return !!p && existsSync(p);
  } catch {
    // executablePath() throws if the browser isn't installed at all.
    return false;
  }
}

/**
 * Download Chromium if missing. Resolves once the browser is on disk.
 * Uses `npx playwright install chromium` — it knows how to fetch the exact
 * build playwright-core expects and writes it to the standard cache dir. We
 * don't bundle the browser binary (~150MB) in the app: first use triggers a
 * one-time download; subsequent launches reuse the cached build.
 */
export async function ensureChromium(): Promise<void> {
  if (isChromiumInstalled()) return;

  const ok = await runInstall();
  if (!ok || !isChromiumInstalled()) {
    throw new Error(
      "Chromium is not installed and automatic download failed. " +
        "Run `npx playwright install chromium` manually in the siberflow repo, then retry.",
    );
  }
}

/** Spawn `npx playwright install chromium` and await its exit. */
function runInstall(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["--yes", "playwright", "install", "chromium"],
      { stdio: "inherit", shell: process.platform === "win32" },
    );
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
