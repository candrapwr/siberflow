#!/usr/bin/env node
/**
 * Stage `puppeteer-core` into the extension's local node_modules before
 * `vsce package`, and clean it up after.
 *
 * WHY THIS EXISTS
 * ---------------
 * This is a monorepo (npm workspaces). npm hoists shared deps to the workspace
 * ROOT `node_modules/`, so `puppeteer-core` lives at
 * `<root>/node_modules/puppeteer-core`, NOT at
 * `packages/vscode-ext/node_modules/puppeteer-core`.
 *
 * But `vsce package --no-dependencies` (which we must use — see the esbuild
 * version conflict that breaks `npm list --production`) packages only files
 * under the extension directory, and our `.vscodeignore` whitelist expects
 * `node_modules/puppeteer-core/**` to live locally. With the dep hoisted,
 * `vsce ls` shows zero puppeteer-core files → run_browser fails at runtime
 * ("could not locate puppeteer-core on disk").
 *
 * WHAT IT DOES
 * ------------
 * `stage`  — copy the hoisted puppeteer-core into ./node_modules/ so vsce
 *            picks it up. Idempotent: skips if already present locally.
 * `clean`  — remove the staged copy (leave the workspace as it was).
 *
 * Run automatically as prepackage/postpackage hooks; can also be invoked
 * directly: `node scripts/stage-puppeteer.mjs stage`
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");
// Walk up from the extension root to find the workspace root (the dir whose
// node_modules holds the hoisted puppeteer-core). In this repo that's two
// levels up: packages/vscode-ext -> packages -> <workspace root>.
const wsRoot = resolve(extRoot, "..", "..");
const source = join(wsRoot, "node_modules", "puppeteer-core");
// IMPORTANT: stage under `vendor/`, NOT `node_modules/`. `vsce` ignores the
// entire node_modules/ subtree regardless of .vscodeignore whitelists (it
// hardcodes that exclusion), so a copy there would never reach the VSIX. A
// top-level `vendor/` dir is packaged normally and survives --no-dependencies.
// resolvePuppeteerCorePath() finds it via the SIBERFLOW_PUPPETEER_CORE_PATH
// env var the host sets to <extensionPath>/vendor/puppeteer-core.
const dest = join(extRoot, "vendor", "puppeteer-core");

function pkgVersion(p) {
  try {
    return JSON.parse(readFileSync(join(p, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function stage() {
  if (!existsSync(source)) {
    throw new Error(
      `puppeteer-core not found at workspace root: ${source}\n` +
        "Run `npm install` at the workspace root first.",
    );
  }
  // Already staged locally (e.g. re-run): verify version matches and bail.
  if (existsSync(dest)) {
    const srcV = pkgVersion(source);
    const dstV = pkgVersion(dest);
    if (srcV && srcV === dstV) {
      console.log(`[stage-puppeteer] already staged (v${dstV}), skipping.`);
      return;
    }
    console.log(
      `[stage-puppeteer] local v${dstV} != source v${srcV}, re-staging.`,
    );
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
  console.log(
    `[stage-puppeteer] staged puppeteer-core v${pkgVersion(dest)} -> ${dest}`,
  );
}

function clean() {
  if (!existsSync(dest)) return;
  rmSync(dest, { recursive: true, force: true });
  // Remove the now-empty vendor/ dir if it has nothing else staged.
  const vendorDir = dirname(dest);
  try {
    rmSync(vendorDir, { recursive: true, force: true });
  } catch { /* not empty — leave it */ }
  console.log("[stage-puppeteer] cleaned staged puppeteer-core.");
}

const cmd = process.argv[2];
if (cmd === "stage") stage();
else if (cmd === "clean") clean();
else {
  console.error("usage: node scripts/stage-puppeteer.mjs [stage|clean]");
  process.exit(1);
}
