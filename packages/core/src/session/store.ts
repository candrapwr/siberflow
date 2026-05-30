import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Message } from "../agent/types.js";
import type { Session, SessionSummary, SessionUsage } from "./types.js";
import { SESSION_FORMAT_VERSION } from "./types.js";

const SESSIONS_DIR = join(homedir(), ".siberflow", "sessions");

async function ensureDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function pathFor(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function optimizedPathFor(id: string): string {
  return join(SESSIONS_DIR, `${id}.optimized.json`);
}

export function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

export async function saveSession(session: Session): Promise<void> {
  await ensureDir();
  await writeFile(pathFor(session.id), JSON.stringify(session, null, 2), "utf8");
}

/**
 * Synchronous variant — used for hot-path saves (e.g. after each task_update)
 * where we need the disk write to complete before the process can exit (Ctrl+C
 * scenarios). Blocking, but small file so latency is negligible.
 */
export function saveSessionSync(session: Session): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(
    pathFor(session.id),
    JSON.stringify(session, null, 2),
    "utf8",
  );
}

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const content = await readFile(pathFor(id), "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== SESSION_FORMAT_VERSION) {
      throw new Error(
        `Session ${id} has unsupported format version ${String(parsed.version)}`,
      );
    }
    return {
      ...(parsed as unknown as Session),
      usage: normalizeUsage(parsed.usage),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const ZERO = (): { promptTokens: number; completionTokens: number } => ({
  promptTokens: 0,
  completionTokens: 0,
});

function normalizeUsage(raw: unknown): SessionUsage {
  if (!raw || typeof raw !== "object") {
    return { last: ZERO(), total: ZERO() };
  }
  const u = raw as Record<string, unknown>;
  // New nested shape: { last, total }
  if ("last" in u && "total" in u) {
    return u as unknown as SessionUsage;
  }
  // Legacy flat shape from previous version: { promptTokens, completionTokens }.
  // Earlier code accumulated, so treat the legacy value as `total` (billing-style).
  if (typeof u.promptTokens === "number" && typeof u.completionTokens === "number") {
    return {
      last: ZERO(),
      total: { promptTokens: u.promptTokens, completionTokens: u.completionTokens },
    };
  }
  return { last: ZERO(), total: ZERO() };
}

export async function deleteSession(id: string): Promise<boolean> {
  let removed = false;
  try {
    await unlink(pathFor(id));
    removed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Best-effort cleanup of the optimized view file (if any).
  try {
    await unlink(optimizedPathFor(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return removed;
}

/**
 * Write a sibling file `<id>.optimized.json` that mirrors the session JSON
 * but with `messages` replaced by the optimized view. Intended for
 * monitoring: lets you inspect what the LLM actually sees when context
 * optimization is enabled. The original `<id>.json` is untouched.
 */
export async function saveOptimizedView(
  session: Session,
  optimizedMessages: Message[],
): Promise<void> {
  await ensureDir();
  const view = {
    ...session,
    messages: optimizedMessages,
    _view: "optimized" as const,
    _generatedAt: new Date().toISOString(),
  };
  await writeFile(
    optimizedPathFor(session.id),
    JSON.stringify(view, null, 2),
    "utf8",
  );
}

/**
 * Delete every session matching the filter. Returns the number removed.
 * Without a filter, deletes ALL sessions across all projects.
 */
export async function clearSessions(filter?: {
  projectDir?: string;
}): Promise<number> {
  const summaries = await listSessions(filter);
  let removed = 0;
  for (const s of summaries) {
    if (await deleteSession(s.id)) removed++;
  }
  return removed;
}

export async function listSessions(filter?: {
  projectDir?: string;
}): Promise<SessionSummary[]> {
  await ensureDir();
  const files = await readdir(SESSIONS_DIR);
  const out: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (f.endsWith(".optimized.json")) continue; // sibling monitoring file
    try {
      const raw = await readFile(join(SESSIONS_DIR, f), "utf8");
      const s = JSON.parse(raw) as Session;
      if (filter?.projectDir && s.projectDir !== filter.projectDir) continue;
      out.push({
        id: s.id,
        name: s.name,
        projectDir: s.projectDir,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      });
    } catch {
      // skip corrupt files
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function findByNameOrId(
  query: string,
  projectDir?: string,
): Promise<Session | null> {
  const summaries = await listSessions(
    projectDir ? { projectDir } : undefined,
  );
  const match =
    summaries.find((s) => s.name === query) ??
    summaries.find((s) => s.id === query) ??
    summaries.find((s) => s.id.startsWith(query));
  if (!match) return null;
  return loadSession(match.id);
}

export function sessionsDir(): string {
  return SESSIONS_DIR;
}
