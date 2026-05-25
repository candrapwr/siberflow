import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

/**
 * Resolve `p` against `projectDir` and ensure the final path stays inside the
 * project sandbox. Symlinks are followed. Non-existent leaf paths are allowed
 * (so write_file can target new files), as long as the deepest existing
 * ancestor is inside `projectDir`.
 */
export async function resolveWithin(
  projectDir: string,
  p: string,
): Promise<string> {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  const target = isAbsolute(p) ? p : resolve(projectDir, p);
  const targetReal = await realpathAllowingMissing(target);
  const projectReal = await realpath(projectDir);

  const rel = relative(projectReal, targetReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return targetReal;
  }
  throw new Error(
    `Path is outside the project directory.\n` +
      `  requested: ${p}\n` +
      `  resolved:  ${targetReal}\n` +
      `  project:   ${projectReal}`,
  );
}

async function realpathAllowingMissing(p: string): Promise<string> {
  const trailing: string[] = [];
  let current = normalize(p);
  while (true) {
    try {
      const real = await realpath(current);
      if (trailing.length === 0) return real;
      return join(real, ...trailing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(current);
      if (parent === current) return normalize(p);
      trailing.push(basename(current));
      current = parent;
    }
  }
}
