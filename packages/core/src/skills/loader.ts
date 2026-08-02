import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  Skill,
  SkillLoadResult,
  SkillParseError,
  SkillScope,
} from "./types.js";

/**
 * ─────────────────────────────────────────────────────────────────────────
 * Skill file format
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   ---
 *   name: my-skill
 *   description: What it does + when to use it. Trigger phrasing up front.
 *   enabled: true
 *   ---
 *   # Body (markdown instructions)
 *   ...
 *
 * Frontmatter is a FLAT `key: value` block delimited by `---` lines. Only
 * `name`, `description`, and `enabled` are honored; unknown keys are ignored.
 * Multi-line values are not supported by the flat parser on purpose — keep the
 * description to a single line (≤1024 chars). The body is everything after the
 * closing `---`.
 */

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_NAME_CHARS = 64;

/** Flat `key: value` parse result; values are the raw strings after the colon. */
type Frontmatter = Record<string, string>;

/**
 * Parse a leading `---\n...\n---` frontmatter block. Returns `{ frontmatter,
 * body }` where `frontmatter` maps the recognized keys to their raw string
 * values and `body` is everything after the closing delimiter. Files without a
 * leading `---` are treated as body-only (frontmatter empty) so a plain
 * markdown file still loads — but it'll fail name validation downstream.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  // A frontmatter block must be the very first thing in the file, opening with
  // a `---` line. Tolerate a leading BOM and CRLF line endings.
  const src = content.replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0]!.trim() !== "---") {
    return { frontmatter: {}, body: src };
  }

  const fm: Frontmatter = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") break; // closing delimiter
    // Blank lines inside the block: skip, don't terminate (lenient).
    if (line.trim() === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue; // malformed line — ignore, keep scanning
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.length > 0) fm[key] = value;
  }

  // If we never found a closing delimiter, treat the whole thing as body so we
  // don't silently swallow the file's content.
  const body = i < lines.length ? lines.slice(i + 1).join("\n") : src;
  return { frontmatter: fm, body };
}

/** Coerce a raw frontmatter string into a boolean. Defaults to true. */
function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true; // omitted = enabled
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

/**
 * Parse a single skill's content into a validated {@link Skill}. Throws on
 * structural problems (bad name, oversized description) so the directory
 * loader can record them as {@link SkillParseError} and skip just that file
 * rather than failing the whole library.
 */
export function parseSkillFile(
  content: string,
  filePath: string,
  mtime: number,
  scope?: SkillScope,
): Skill {
  const { frontmatter, body } = parseFrontmatter(content);
  const name = (frontmatter.name ?? "").trim();
  const description = (frontmatter.description ?? "").trim();

  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}" — must be 1–${MAX_NAME_CHARS} lowercase kebab-case chars [a-z0-9-].`,
    );
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `Skill description is ${description.length} chars (max ${MAX_DESCRIPTION_CHARS}).`,
    );
  }

  return {
    name,
    description,
    enabled: parseEnabled(frontmatter.enabled),
    body,
    filePath,
    mtime,
    ...(scope !== undefined ? { scope } : {}),
  };
}

/**
 * Load every `.md` skill file from a directory. A missing directory yields an
 * empty list (not an error) — fresh installs start with no skills. Per-file
 * parse failures are collected, never thrown, so one bad file can't break the
 * whole library.
 */
export async function loadSkillsFromDir(
  dir: string,
  scope?: SkillScope,
): Promise<{ skills: Skill[]; errors: SkillParseError[] }> {
  const skills: Skill[] = [];
  const errors: SkillParseError[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet (fresh install). Nothing to load.
    return { skills, errors };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      const content = await readFile(filePath, "utf8");
      const st = await stat(filePath);
      skills.push(parseSkillFile(content, filePath, st.mtimeMs, scope));
    } catch (err) {
      errors.push({
        filePath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { skills, errors };
}

/**
 * Load skills from one or more directories (later dirs shadow earlier ones by
 * name). Each directory may also be tagged with a scope. Returns deduped
 * skills + any per-file parse errors.
 *
 * For single-library hosts (e.g. the Telegram bot) pass just one entry — no
 * shadowing occurs. Multi-user hosts pass global + user dirs so user skills
 * override global ones with the same name.
 */
export async function loadSkills(
  ...dirs: Array<string | { dir: string; scope?: SkillScope }>
): Promise<SkillLoadResult> {
  const skills: Skill[] = [];
  const errors: SkillParseError[] = [];

  for (const entry of dirs) {
    const dir = typeof entry === "string" ? entry : entry.dir;
    const scope = typeof entry === "string" ? undefined : entry.scope;
    const result = await loadSkillsFromDir(dir, scope);
    errors.push(...result.errors);
    for (const skill of result.skills) {
      // Shadow: a later dir's skill with the same name replaces the earlier one.
      const idx = skills.findIndex((s) => s.name === skill.name);
      if (idx >= 0) skills[idx] = skill;
      else skills.push(skill);
    }
  }

  // Stable, predictable ordering for prompt + caching: alphabetical by name.
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
}

/**
 * Build the compact `# Skills` index block for the system prompt. Only enabled
 * skills are listed; the body is NOT included — the model reads it on demand
 * via `read_file`. Returns an empty string when there are no enabled skills,
 * so the prompt stays clean for an empty library.
 *
 * The index tells the model WHERE the skill bodies live (the skill dirs) so it
 * can `read_file` the relevant `.md` when a task matches. Paths use the skill's
 * own `filePath` so the read resolves through the expanded read-root sandbox.
 */
export function buildSkillIndexPrompt(skills: Skill[]): string {
  const enabled = skills.filter((s) => s.enabled);
  if (enabled.length === 0) return "";

  const lines = enabled.map((s) => {
    const desc = s.description.length > 0 ? s.description : "(no description)";
    return `- **${s.name}** — ${desc}`;
  });

  return (
    "\n\n# Skills\n" +
    "Reusable skill files (.md) are available. When a task matches a skill's description, " +
    "read its file first with `read_file` (path below) and follow the guidance in it, then " +
    "proceed with the task using the tools you already have. Skills are read-only.\n\n" +
    lines.join("\n") +
    "\n\n" +
    "Skill file paths (use these with read_file):\n" +
    enabled.map((s) => `- ${s.name}: ${s.filePath}`).join("\n")
  );
}

/**
 * Compute a compact signature of the active skill set so the agent host can
 * detect drift (added/removed/edited/toggled skill) and rebuild its cached
 * runtime. Includes name, enabled flag, mtime, and scope — enough to invalidate
 * on any meaningful change without re-reading file bodies.
 */
export function skillSignature(skills: Skill[]): string {
  return skills
    .map((s) => `${s.scope ?? ""}:${s.name}:${s.enabled ? 1 : 0}:${s.mtime}`)
    .join("|");
}
