import { readdirSync, rmSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

const cwd = process.cwd();
const patterns = process.argv.slice(2);

if (patterns.length === 0) {
  console.error("Usage: node scripts/clean.mjs <path...>");
  process.exit(1);
}

function assertInsideCwd(target, allowRoot = false) {
  const rel = relative(cwd, target);
  const isRoot = rel === "" || rel === ".";
  if ((!allowRoot && isRoot) || rel.startsWith("..") || resolve(cwd, rel) !== target) {
    throw new Error(`Refusing to remove path outside the package directory: ${target}`);
  }
}

function wildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function remove(target) {
  assertInsideCwd(target);
  rmSync(target, { recursive: true, force: true });
}

for (const pattern of patterns) {
  const name = basename(pattern);
  if (!name.includes("*") && !name.includes("?")) {
    remove(resolve(cwd, pattern));
    continue;
  }

  const parent = resolve(cwd, dirname(pattern));
  assertInsideCwd(parent, true);
  const matcher = wildcardRegex(name);
  let entries = [];
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") continue;
    throw err;
  }
  for (const entry of entries) {
    if (matcher.test(entry.name)) remove(resolve(parent, entry.name));
  }
}
