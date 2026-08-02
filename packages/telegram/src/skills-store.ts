/**
 * Skill library store for the Telegram bot.
 *
 * Skills are reusable prompt `.md` files (flat frontmatter + body) the agent
 * reads on demand via `read_file`. The Telegram bot uses a single GLOBAL
 * library at `<dataRoot>/telegram-skills/<name>.md`, active for every chat.
 * Management is admin-only via the web panel (port 7070, OTP-gated); there is
 * no per-user or per-chat scope here.
 *
 * Pure filesystem — no DB. CRUD (web panel) writes files directly; the agent
 * host reads them back when (re)building the per-turn system prompt. The
 * directory is created lazily on first write, so a fresh install has no skills
 * and the loader just returns an empty list.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** The global Telegram skill library directory. */
export const SKILLS_DIR = join(
  homedir(),
  ".siberflow",
  "telegram-skills",
);

/**
 * The single read-root the agent host injects so read_file/list_dir can reach
 * skill bodies (which live outside the session workdir by design). Write tools
 * never see this list, so skills stay read-only to the agent.
 */
export const SKILL_READ_ROOTS: readonly string[] = [SKILLS_DIR];
