// Pre-build step: remove the `cpu-features` optionalDependency of ssh2 before
// `electron-builder install-app-deps` runs. Without this, install-app-deps
// tries to rebuild cpu-features against Electron's V8 headers, which fails
// (the V8 ExternalPointerTypeTag ABI changed in Electron 42) and aborts the
// whole packaging step.
//
// cpu-features is purely a perf optimization for ssh2 (CPU feature detection
// for AES-NI etc). ssh2 falls back to its pure-JS crypto path without it —
// functionally identical, marginally slower for bulk transfers.
//
// We delete the directory rather than trying to suppress the rebuild via npm
// config because npm 10+ ignores workspace-level .npmrc and the root-level
// `omit=` is interpreted as a package-type list (dev/optional/peer), not a
// package-name list. Deletion is the most reliable cross-platform fix and
// is idempotent.
//
// Run before: `electron-builder install-app-deps`.
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const targets = [
  // hoisted at the monorepo root (npm workspaces)
  join(root.pathname, "node_modules/cpu-features"),
  // fallback: nested under core (shouldn't happen with hoisting but be safe)
  join(root.pathname, "packages/core/node_modules/cpu-features"),
];

let removed = 0;
for (const dir of targets) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed++;
    console.log(`[strip-cpu-features] removed ${dir}`);
  }
}
if (removed === 0) {
  console.log("[strip-cpu-features] cpu-features not present, nothing to remove");
}
