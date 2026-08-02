/**
 * Skill = a reusable prompt markdown file with flat YAML-like frontmatter.
 *
 * A skill is a flat `.md` file laid out on disk, e.g. for the Telegram bot:
 *   <dataRoot>/telegram-skills/<name>.md
 *
 * The file frontmatter carries `name`, `description`, and `enabled`; the body
 * is the instruction markdown the model reads on demand via `read_file`. Only
 * the frontmatter index (name + 1-line description) is injected into the
 * system prompt — the body is lazy-loaded, keeping the prompt lean.
 *
 * Files are the single source of truth: no DB table mirrors them, and CRUD
 * (admin web panel) writes/reads files directly.
 */

/**
 * Optional scope tag for a skill. Hosts may use this to distinguish skill
 * libraries (e.g. "global" vs "user" in multi-user hosts); the Telegram bot is
 * single-library so it leaves this unset.
 */
export type SkillScope = "global" | "user";

/** A parsed skill loaded from disk. */
export interface Skill {
  /** Kebab-case identifier `[a-z0-9-]{1,64}`. Also the filename stem. */
  name: string;
  /** Short trigger description (≤1024 chars). What + when, front-loaded. */
  description: string;
  /** Whether the skill is offered to the model. Disabled skills still load
   *  (so the UI can show them) but are omitted from the prompt index. */
  enabled: boolean;
  /** Full instruction body (markdown after the frontmatter). May be large. */
  body: string;
  /** Absolute path to the source `.md` file on disk. */
  filePath: string;
  /** mtime (ms) of the source file — used for cache invalidation signatures. */
  mtime: number;
  /** Optional scope tag set by the host (global/user). Absent when unused. */
  scope?: SkillScope;
}

/** Reason a skill file failed to parse. Surfaced to the UI, never thrown past
 *  the loader (a single bad file doesn't break the rest of the library). */
export interface SkillParseError {
  /** The file that failed. */
  filePath: string;
  /** Human-readable reason. */
  reason: string;
}

/** Result of loading all skills from one or more directories. */
export interface SkillLoadResult {
  /** All valid skills. */
  skills: Skill[];
  /** Files that failed validation — non-fatal, surfaced for diagnostics. */
  errors: SkillParseError[];
}
