import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function findDotEnv(startDir: string): Promise<string | null> {
  let dir = startDir;
  while (true) {
    const candidate = resolve(dir, ".env");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadDotEnv(cwd: string = process.cwd()): Promise<void> {
  const path = await findDotEnv(cwd);
  if (!path) return;

  const content = await readFile(path, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}
