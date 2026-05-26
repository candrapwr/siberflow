import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { Session, SessionSummary } from "./types.js";
import { SESSION_FORMAT_VERSION } from "./types.js";

const SESSIONS_DIR = join(homedir(), ".siberflow", "sessions");

async function ensureDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function pathFor(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
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

export async function loadSession(id: string): Promise<Session | null> {
  try {
    const content = await readFile(pathFor(id), "utf8");
    const parsed = JSON.parse(content) as Partial<Session>;
    if (parsed.version !== SESSION_FORMAT_VERSION) {
      throw new Error(
        `Session ${id} has unsupported format version ${parsed.version}`,
      );
    }
    return {
      ...(parsed as Session),
      usage: parsed.usage ?? { promptTokens: 0, completionTokens: 0 },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await unlink(pathFor(id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
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
