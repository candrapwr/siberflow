/**
 * Local-only admin web service for the Telegram bot.
 *
 * Starts alongside the bot (from main()) and serves a single-page HTML admin
 * UI plus a small JSON API. Lets you browse Telegram sessions (private chats,
 * groups, and group forum threads), inspect the raw (non-optimized) session
 * JSON as a structured log table with tool calls & results, list a session's
 * workdir, delete a session + its workdir, and send a message to any chat by
 * id. Only Telegram sessions (id prefixed `telegram-`) are exposed.
 *
 * Security: binds to 127.0.0.1 only and requires a bearer token on every
 * request. If SIBERFLOW_TELEGRAM_ADMIN_TOKEN is unset, a random token is
 * generated and logged at startup.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  deleteSession,
  listSessions,
  loadSession,
  type Session,
} from "@siberflow/core";
import type { TelegramApi } from "./index.js";
import { ADMIN_HTML } from "./web-ui.js";

/** Options passed from main() to start the admin web service. */
export interface WebServiceOptions {
  api: TelegramApi;
  workdirRoot: string;
  port: number;
  token: string;
}

/** Parsed components of a Telegram session id. */
interface ParsedSessionId {
  chatType: "private" | "group" | "supergroup";
  chatId: number;
  /** Forum thread id, or null for the main (non-topic) session. */
  threadId: number | null;
}

/**
 * Regex matching telegram session ids produced by sessionIdFor():
 *   telegram-<chatType>-<chatId>-main
 *   telegram-<chatType>-<chatId>-thread-<threadId>
 * chatId is negative for groups/supergroups, so the leading `-` is kept.
 */
const SESSION_ID_RE =
  /^telegram-(private|group|supergroup)-(-?\d+)-(main|thread-(\d+))$/;

/** Parse a telegram session id into its components. Returns null if the id
 * doesn't match the expected shape (e.g. a non-telegram or malformed id). */
export function parseSessionId(id: string): ParsedSessionId | null {
  const m = SESSION_ID_RE.exec(id);
  if (!m) return null;
  const chatType = m[1] as ParsedSessionId["chatType"];
  const chatId = Number(m[2]);
  const threadId = m[4] ? Number(m[4]) : null;
  return { chatType, chatId, threadId };
}

/** Generate a random hex token (24 bytes → 48 hex chars). */
export function generateAdminToken(): string {
  return randomBytes(24).toString("hex");
}

/** A single row in the structured message log returned by /api/session/:id. */
interface MessageRow {
  index: number;
  role: "system" | "user" | "assistant" | "tool";
  label: string;
  content: string;
  /** Present when an assistant message carries tool calls. */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** Present for tool-result messages: which tool produced this result. */
  toolResult?: { toolCallId: string; name: string };
}

/** One entry in a session list response. */
interface SessionListItem {
  id: string;
  name: string | null;
  chatType: string;
  chatId: number | null;
  threadId: number | null;
  username: string | null;
  messageCount: number;
  updatedAt: string;
  knownMembersCount: number;
}

/** One file/dir entry in a workdir listing. */
interface WorkdirEntry {
  path: string;
  size: number;
  isDir: boolean;
}

const CONTENT_PREVIEW_LIMIT = 4000;

/** Extract the human-readable label for a message role. */
function labelFor(role: string): string {
  switch (role) {
    case "system":
      return "SYSTEM";
    case "user":
      return "USER";
    case "assistant":
      return "ASSISTANT";
    case "tool":
      return "TOOL RESULT";
    default:
      return role.toUpperCase();
  }
}

/** Build the structured message log rows from a session's messages array. */
function buildMessageRows(session: Session): MessageRow[] {
  return session.messages.map((msg, index) => {
    const row: MessageRow = {
      index,
      role: msg.role,
      label: labelFor(msg.role),
      content: msg.content ?? "",
    };
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      row.toolCalls = msg.toolCalls;
    }
    if (msg.role === "tool") {
      row.toolResult = { toolCallId: msg.toolCallId, name: msg.name };
    }
    return row;
  });
}

/**
 * Start the admin web service. Returns the http.Server (already listening).
 * The bot polling loop continues to run independently after this resolves —
 * listen() is non-blocking.
 */
export async function startWebService(opts: WebServiceOptions): Promise<Server> {
  const { api, workdirRoot, port, token } = opts;
  const server = createServer((req, res) => {
    void handleRequest(req, res, { api, workdirRoot, token }).catch((err) => {
      console.error(`Admin web error: ${(err as Error).message}`);
      sendJson(res, 500, { error: "Internal server error" });
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}

/** Route a single HTTP request. All routes require the bearer token. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { api: TelegramApi; workdirRoot: string; token: string },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  // Token auth: accept either ?token= (for the HTML page / browser fetch) or
  // Authorization: Bearer <token> (for API clients). 401 on mismatch.
  const tokenParam = url.searchParams.get("token");
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const providedToken = tokenParam ?? bearerToken;
  if (providedToken !== ctx.token) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  // ── HTML page ──────────────────────────────────────────────────────────
  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(ADMIN_HTML);
    return;
  }

  // ── JSON API ───────────────────────────────────────────────────────────
  if (path === "/api/sessions" && req.method === "GET") {
    return handleListSessions(res);
  }
  const sessionMatch = path.match(/^\/api\/session\/(.+)$/);
  if (sessionMatch && req.method === "GET") {
    return handleGetSession(res, decodeURIComponent(sessionMatch[1]!));
  }
  const workdirMatch = path.match(/^\/api\/workdir\/(.+)$/);
  if (workdirMatch && req.method === "GET") {
    return handleListWorkdir(res, ctx.workdirRoot, decodeURIComponent(workdirMatch[1]!));
  }
  const deleteMatch = path.match(/^\/api\/delete\/(.+)$/);
  if (deleteMatch && req.method === "POST") {
    return handleDeleteSession(res, ctx.workdirRoot, decodeURIComponent(deleteMatch[1]!));
  }
  if (path === "/api/send" && req.method === "POST") {
    return handleSendMessage(req, res, ctx.api);
  }

  sendJson(res, 404, { error: "Not found" });
}

/** GET /api/sessions — list all Telegram sessions with user/chat metadata. */
async function handleListSessions(res: ServerResponse): Promise<void> {
  // listSessions already skips optimized sibling files and (without the flag)
  // skips telegram ids — we explicitly request telegram sessions here.
  const summaries = await listSessions({ includeTelegram: true });
  const items: SessionListItem[] = [];
  for (const s of summaries) {
    // Only telegram sessions — listSessions with includeTelegram may still
    // return non-telegram ids on some code paths; filter defensively.
    if (!s.id.startsWith("telegram-")) continue;
    const parsed = parseSessionId(s.id);
    // Load the full session to read knownMembers & username. Telegram sessions
    // are few in number, so the extra read is cheap and keeps the list accurate.
    let knownMembersCount = 0;
    let username: string | null = null;
    const full = await loadSession(s.id);
    if (full) {
      if (full.knownMembers) {
        knownMembersCount = Object.keys(full.knownMembers).length;
      }
      // For private chats the session name is the @username (e.g. "@candrapwr").
      // For groups it's the group title. We surface whatever is stored.
      if (parsed?.chatType === "private" && full.name?.startsWith("@")) {
        username = full.name;
      }
    }
    items.push({
      id: s.id,
      name: s.name,
      chatType: parsed?.chatType ?? "unknown",
      chatId: parsed?.chatId ?? null,
      threadId: parsed?.threadId ?? null,
      username,
      messageCount: s.messageCount,
      updatedAt: s.updatedAt,
      knownMembersCount,
    });
  }
  sendJson(res, 200, items);
}

/** GET /api/session/:id — return the raw (non-optimized) message log. */
async function handleGetSession(res: ServerResponse, id: string): Promise<void> {
  if (!id.startsWith("telegram-")) {
    sendJson(res, 400, { error: "Only telegram sessions are accessible." });
    return;
  }
  const session = await loadSession(id);
  if (!session) {
    sendJson(res, 404, { error: "Session not found." });
    return;
  }
  const rows = buildMessageRows(session);
  // Truncate very long content (system prompts can be huge) for the list view;
  // the full content is available via a click-to-expand that fetches the raw
  // row. We flag truncated rows so the UI can show a "show more" affordance.
  const trimmed = rows.map((r) => {
    if (r.content.length > CONTENT_PREVIEW_LIMIT) {
      return {
        ...r,
        content: r.content.slice(0, CONTENT_PREVIEW_LIMIT),
        truncated: true,
        fullLength: r.content.length,
      };
    }
    return r;
  });
  sendJson(res, 200, {
    id: session.id,
    name: session.name,
    provider: session.provider,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    usage: session.usage,
    knownMembers: session.knownMembers ?? null,
    messages: trimmed,
  });
}

/** GET /api/workdir/:id — recursively list a session's workdir contents. */
async function handleListWorkdir(
  res: ServerResponse,
  workdirRoot: string,
  id: string,
): Promise<void> {
  if (!id.startsWith("telegram-")) {
    sendJson(res, 400, { error: "Only telegram sessions are accessible." });
    return;
  }
  // Resolve and ensure the path stays inside workdirRoot (no traversal).
  const dir = resolve(workdirRoot, id);
  const rel = relative(workdirRoot, dir);
  if (rel.startsWith("..") || rel.includes("..")) {
    sendJson(res, 400, { error: "Invalid workdir path." });
    return;
  }
  try {
    const entries: WorkdirEntry[] = [];
    await walkDir(dir, dir, entries);
    sendJson(res, 200, { path: dir, entries });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 200, { path: dir, entries: [] });
      return;
    }
    throw err;
  }
}

/** Recursively collect files/dirs under `root`, paths relative to `base`. */
async function walkDir(
  root: string,
  base: string,
  out: WorkdirEntry[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root, { withFileTypes: true }).then((ds) =>
      ds.filter((d) => d.name !== ".DS_Store").map((d) => d.name),
    );
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(root, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push({ path: relative(base, full), size: 0, isDir: true });
      await walkDir(full, base, out);
    } else {
      out.push({ path: relative(base, full), size: st.size, isDir: false });
    }
  }
}

/** POST /api/delete/:id — delete the session JSON + its workdir. */
async function handleDeleteSession(
  res: ServerResponse,
  workdirRoot: string,
  id: string,
): Promise<void> {
  if (!id.startsWith("telegram-")) {
    sendJson(res, 400, { error: "Only telegram sessions are accessible." });
    return;
  }
  // deleteSession removes <id>.json + optimized siblings + tmp uploads.
  const removed = await deleteSession(id);
  // Best-effort workdir removal. force:true so a missing dir is not an error.
  const workdirPath = join(workdirRoot, id);
  let workdirRemoved = false;
  try {
    await rm(workdirPath, { recursive: true, force: true });
    workdirRemoved = true;
  } catch (err) {
    console.error(`Admin web: failed to remove workdir ${workdirPath}: ${(err as Error).message}`);
  }
  sendJson(res, 200, { ok: true, removed, workdirRemoved });
}

/** POST /api/send — send a text message to a chat by id via the bot. */
async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  api: TelegramApi,
): Promise<void> {
  const body = await readJsonBody(req);
  const chatId = Number(body.chatId);
  const text = typeof body.text === "string" ? body.text : "";
  const threadId = body.threadId != null ? Number(body.threadId) : undefined;
  if (!Number.isFinite(chatId) || !text.trim()) {
    sendJson(res, 400, { error: "chatId (number) and text (non-empty) are required." });
    return;
  }
  try {
    const result = await api.sendMessage({
      chat_id: chatId,
      text,
      ...(threadId != null ? { message_thread_id: threadId } : {}),
    });
    sendJson(res, 200, { ok: true, messageId: result.message_id });
  } catch (err) {
    // Telegram errors (e.g. "Forbidden: bot can't initiate conversation with a
    // user") surface here — relay them to the UI so the admin knows why.
    sendJson(res, 200, { ok: false, error: (err as Error).message });
  }
}

/** Read and parse a JSON request body. Returns {} on empty/invalid body. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Send a JSON response with the given status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
