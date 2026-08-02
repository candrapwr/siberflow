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
 *
 * `extraReadRoots` lists additional directories that read-only tools may also
 * resolve into — used to grant `read_file`/`list_dir` access to the skill
 * library directories (which live outside `projectDir` by design). A path that
 * escapes `projectDir` is still accepted if it falls inside one of these
 * read-roots; callers that need write access must NOT pass extraReadRoots, so
 * the skill library stays read-only to the agent.
 */
export async function resolveWithin(
  projectDir: string,
  p: string,
  extraReadRoots: string[] = [],
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

  // Not inside the project dir — fall back to the read-only extra roots.
  // Each root must exist on disk (realpath throws otherwise), so skip missing
  // ones silently rather than failing; an empty/missing skills dir is normal.
  for (const root of extraReadRoots) {
    try {
      const rootReal = await realpath(root);
      const relRoot = relative(rootReal, targetReal);
      if (relRoot === "" || (!relRoot.startsWith("..") && !isAbsolute(relRoot))) {
        return targetReal;
      }
    } catch {
      // Root doesn't exist (yet) — ignore, try the next one.
    }
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
