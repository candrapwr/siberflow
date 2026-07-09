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
import { LOGIN_HTML } from "./login-page.js";
import {
  deleteImageGenPreset,
  deleteMainPreset,
  isMaskedApiKey,
  loadImageGenPresets,
  loadMainPresets,
  maskApiKey,
  saveImageGenPreset,
  saveMainPreset,
  type ImageGenPreset,
  type MainProviderPreset,
  type TelegramAiSettings,
} from "./settings.js";
import {
  approveLogin,
  pollLogin,
  revokeSession,
  startLogin,
  verifySession,
} from "./auth.js";

/** Options passed from main() to start the admin web service. */
export interface WebServiceOptions {
  api: TelegramApi;
  workdirRoot: string;
  port: number;
  /** Returns the current AI provider override settings (for GET endpoint). */
  getAiSettings: () => TelegramAiSettings;
  /** Applies new AI settings (persist + rebuild agents). May throw on invalid. */
  applyAiSettings: (s: TelegramAiSettings) => Promise<void>;
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
  const { api, workdirRoot, port, getAiSettings, applyAiSettings } = opts;
  const server = createServer((req, res) => {
    void handleRequest(req, res, { api, workdirRoot, getAiSettings, applyAiSettings }).catch((err) => {
      console.error(`Admin web error: ${(err as Error).message}`);
      sendJson(res, 500, { error: "Internal server error" });
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}

/** Route a single HTTP request. Public routes (login) bypass session auth. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    api: TelegramApi;
    workdirRoot: string;
    getAiSettings: () => TelegramAiSettings;
    applyAiSettings: (s: TelegramAiSettings) => Promise<void>;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  // ── Public auth routes (no session required) ───────────────────────────
  if (path === "/api/login/start" && req.method === "GET") {
    const code = startLogin();
    sendJson(res, 200, { code });
    return;
  }
  if (path === "/api/login/poll" && req.method === "GET") {
    const code = url.searchParams.get("code") ?? "";
    const result = pollLogin(code);
    // On approval, set a session cookie so the subsequent page reload carries
    // the token automatically (browsers send cookies on navigation, unlike
    // custom headers). The token is also returned in the JSON body for the
    // localStorage copy used by fetch calls.
    if (result.status === "approved" && result.token) {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": sessionCookie(result.token),
      });
      res.end(JSON.stringify(result));
      return;
    }
    sendJson(res, 200, result);
    return;
  }
  if (path === "/api/logout" && req.method === "POST") {
    const token = extractSessionToken(req);
    if (token) revokeSession(token);
    // Clear the cookie so the browser stops sending the revoked token.
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": clearSessionCookie(),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Session auth: every other route requires a valid session token ─────
  const sessionToken = extractSessionToken(req);
  const adminUserId = sessionToken ? verifySession(sessionToken) : null;

  // HTML page: serve login page when unauthenticated, dashboard when authed.
  if (path === "/" || path === "/index.html") {
    if (adminUserId) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ADMIN_HTML);
    } else {
      // Start a login flow and inject the code into the login page.
      const code = startLogin();
      const html = LOGIN_HTML.replaceAll("__CODE__", code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }
    return;
  }

  // All remaining routes (API) require a valid session.
  if (!adminUserId) {
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
  if (path === "/api/ai-settings" && req.method === "GET") {
    return handleGetAiSettings(res, ctx.getAiSettings);
  }
  if (path === "/api/ai-settings" && req.method === "POST") {
    return handleSaveAiSettings(req, res, ctx.getAiSettings, ctx.applyAiSettings);
  }
  if (path === "/api/tools" && req.method === "GET") {
    return handleListTools(res, ctx.getAiSettings);
  }
  if (path === "/api/image-presets" && req.method === "GET") {
    return handleListImagePresets(res);
  }
  if (path === "/api/image-presets" && req.method === "POST") {
    return handleSaveImagePreset(req, res);
  }
  const presetDeleteMatch = path.match(/^\/api\/image-presets\/(.+)$/);
  if (presetDeleteMatch && req.method === "DELETE") {
    return handleDeleteImagePreset(res, decodeURIComponent(presetDeleteMatch[1]!));
  }
  if (path === "/api/main-presets" && req.method === "GET") {
    return handleListMainPresets(res);
  }
  if (path === "/api/main-presets" && req.method === "POST") {
    return handleSaveMainPreset(req, res);
  }
  const mainPresetDeleteMatch = path.match(/^\/api\/main-presets\/(.+)$/);
  if (mainPresetDeleteMatch && req.method === "DELETE") {
    return handleDeleteMainPreset(res, decodeURIComponent(mainPresetDeleteMatch[1]!));
  }

  sendJson(res, 404, { error: "Not found" });
}

/** GET /api/image-presets — list all saved image-gen presets (keys masked). */
async function handleListImagePresets(res: ServerResponse): Promise<void> {
  const presets = await loadImageGenPresets();
  sendJson(res, 200, presets.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })));
}

/** POST /api/image-presets — create or update a preset by name/id. */
async function handleSaveImagePreset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    sendJson(res, 200, { ok: false, error: "Nama preset wajib diisi." });
    return;
  }
  const presets = await saveImageGenPreset({
    id: typeof body.id === "string" ? body.id : undefined,
    name,
    provider: typeof body.provider === "string" ? body.provider : "openai",
    apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
    model: typeof body.model === "string" ? body.model : "",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
  });
  sendJson(res, 200, {
    ok: true,
    presets: presets.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })),
  });
}

/** DELETE /api/image-presets/:id — remove a preset. */
async function handleDeleteImagePreset(res: ServerResponse, id: string): Promise<void> {
  const presets = await deleteImageGenPreset(id);
  sendJson(res, 200, {
    ok: true,
    presets: presets.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })),
  });
}

// ── Main provider presets ──────────────────────────────────────────────────

/** GET /api/main-presets — list all saved main-provider presets (keys masked). */
async function handleListMainPresets(res: ServerResponse): Promise<void> {
  const presets = await loadMainPresets();
  sendJson(res, 200, presets.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })));
}

/** POST /api/main-presets — create or update a main-provider preset by name/id. */
async function handleSaveMainPreset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    sendJson(res, 200, { ok: false, error: "Nama preset wajib diisi." });
    return;
  }
  const presets = await saveMainPreset({
    id: typeof body.id === "string" ? body.id : undefined,
    name,
    customProviderName: typeof body.customProviderName === "string" ? body.customProviderName : "",
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
    apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
    customDefaultModel: typeof body.customDefaultModel === "string" ? body.customDefaultModel : "",
  });
  sendJson(res, 200, {
    ok: true,
    presets: presets.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })),
  });
}

/** DELETE /api/main-presets/:id — remove a main-provider preset. */
async function handleDeleteMainPreset(res: ServerResponse, id: string): Promise<void> {
  const presets = await deleteMainPreset(id);
  sendJson(res, 200, {
    ok: true,
    presets: presets.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })),
  });
}

/**
 * The full catalog of opt-in tools the admin panel can toggle, grouped by
 * category. Always-on tools (task_update, ask_user) and factory tools
 * (subagent, explore) are listed as informational but cannot be toggled. This
 * mirrors the tool-name universe in packages/core/src/tools/index.ts.
 */
const TOOL_CATALOG: { category: string; tools: { name: string; description: string }[] }[] = [
  {
    category: "File",
    tools: [
      { name: "read_file", description: "Read file contents" },
      { name: "write_file", description: "Write/create files" },
      { name: "edit_file", description: "Edit existing files" },
      { name: "copy_file", description: "Copy files" },
      { name: "list_dir", description: "List directory contents" },
      { name: "delete_file", description: "Delete files" },
      { name: "grep", description: "Search file contents" },
    ],
  },
  {
    category: "Shell",
    tools: [{ name: "exec", description: "Shell execution (admin private chat only)" }],
  },
  {
    category: "Database",
    tools: [{ name: "db_query", description: "SQL queries (MySQL/PostgreSQL/SQLite)" }],
  },
  {
    category: "SSH",
    tools: [
      { name: "ssh_exec", description: "Run commands over SSH" },
      { name: "sftp", description: "SFTP file transfer" },
    ],
  },
  {
    category: "Documents",
    tools: [
      { name: "excel_script", description: "Excel (.xlsx) read/create/modify" },
      { name: "docx_script", description: "Word (.docx) create/read" },
      { name: "pdf_script", description: "PDF create/read/OCR" },
    ],
  },
  {
    category: "Browser",
    tools: [{ name: "run_browser", description: "Headless browser automation (Puppeteer)" }],
  },
  {
    category: "Image",
    tools: [
      { name: "analyze_image", description: "Analyze/describe images (multimodal)" },
      { name: "image_gen", description: "Generate/edit images" },
    ],
  },
  {
    category: "Search",
    tools: [{ name: "web_search", description: "Web search (Exa)" }],
  },
  {
    category: "Music",
    tools: [{ name: "music_generate", description: "Generate music tracks" }],
  },
  {
    category: "Bot",
    tools: [{ name: "bot_script", description: "Bot actions (send media, polls, etc.)" }],
  },
  {
    category: "Speech",
    tools: [
      { name: "speech_to_text", description: "Transcribe audio to text" },
      { name: "text_to_speech", description: "Synthesize speech from text" },
    ],
  },
];

/** GET /api/tools — full catalog + the active/enabled tool set + env tool set. */
function handleListTools(
  res: ServerResponse,
  getAiSettings: () => TelegramAiSettings,
): void {
  const s = getAiSettings();
  // Env tool set (from SIBERFLOW_TELEGRAM_TOOLS).
  const envTools = process.env.SIBERFLOW_TELEGRAM_TOOLS;
  const envEnabled: string[] = envTools
    ? envTools.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
    : ["run_browser"];
  // Active tool set (override or env).
  const activeEnabled: string[] = s.toolsOverride && s.enabledTools
    ? s.enabledTools.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
    : envEnabled;
  sendJson(res, 200, {
    catalog: TOOL_CATALOG,
    active: activeEnabled,
    env: envEnabled,
    toolsOverride: s.toolsOverride,
  });
}

/** GET /api/ai-settings — return current settings with the API key masked. */
function handleGetAiSettings(
  res: ServerResponse,
  getAiSettings: () => TelegramAiSettings,
): void {
  const s = getAiSettings();
  sendJson(res, 200, {
    enabled: s.enabled,
    provider: s.provider,
    customProviderName: s.customProviderName,
    baseUrl: s.baseUrl,
    apiKey: maskApiKey(s.apiKey),
    hasApiKey: s.apiKey.length > 0,
    customDefaultModel: s.customDefaultModel,
    // Image generator override fields.
    imageGenEnabled: s.imageGenEnabled,
    imageGenProvider: s.imageGenProvider,
    imageGenApiKey: maskApiKey(s.imageGenApiKey),
    hasImageGenApiKey: s.imageGenApiKey.length > 0,
    imageGenModel: s.imageGenModel,
    imageGenBaseUrl: s.imageGenBaseUrl,
    // Enabled-tools override fields.
    toolsOverride: s.toolsOverride,
    enabledTools: s.enabledTools,
    updatedAt: s.updatedAt,
  });
}

/** POST /api/ai-settings — validate, preserve masked API key, apply, persist. */
async function handleSaveAiSettings(
  req: IncomingMessage,
  res: ServerResponse,
  getAiSettings: () => TelegramAiSettings,
  applyAiSettings: (s: TelegramAiSettings) => Promise<void>,
): Promise<void> {
  const body = await readJsonBody(req);
  const current = getAiSettings();
  // Each field preserves the current value when absent from the body, so the
  // Tools panel can POST only {toolsOverride, enabledTools} without wiping the
  // provider/image-gen settings, and vice versa.
  const enabled =
    body.enabled === undefined ? current.enabled : body.enabled === true || body.enabled === "true";
  const provider = typeof body.provider === "string" ? body.provider : current.provider;
  const customProviderName =
    typeof body.customProviderName === "string" ? body.customProviderName : current.customProviderName;
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : current.baseUrl;
  const customDefaultModel =
    typeof body.customDefaultModel === "string" ? body.customDefaultModel : current.customDefaultModel;

  // API key handling: if the submitted value is masked (contains *), keep the
  // previously-stored key — the UI sends the masked value back when the user
  // didn't retype the key.
  let apiKey: string;
  const submittedKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (submittedKey && !isMaskedApiKey(submittedKey)) {
    apiKey = submittedKey;
  } else {
    apiKey = current.apiKey;
  }

  // Validate: when enabling, all required fields must be present.
  if (enabled) {
    const missing: string[] = [];
    if (!baseUrl.trim()) missing.push("Base URL");
    if (!apiKey.trim()) missing.push("API key");
    if (!customDefaultModel.trim()) missing.push("Default model");
    if (missing.length > 0) {
      sendJson(res, 200, {
        ok: false,
        error: `Field wajib belum diisi: ${missing.join(", ")}.`,
      });
      return;
    }
  }

  // ── Image generator override fields (preserve current when absent) ──
  const imageGenEnabled =
    body.imageGenEnabled === undefined
      ? current.imageGenEnabled
      : body.imageGenEnabled === true || body.imageGenEnabled === "true";
  const imageGenProvider =
    typeof body.imageGenProvider === "string" ? body.imageGenProvider : current.imageGenProvider;
  const imageGenModel =
    typeof body.imageGenModel === "string" ? body.imageGenModel : current.imageGenModel;
  const imageGenBaseUrl =
    typeof body.imageGenBaseUrl === "string" ? body.imageGenBaseUrl : current.imageGenBaseUrl;

  // Image gen API key masking — same preserve-if-masked logic as the main key.
  let imageGenApiKey: string;
  const submittedImageKey = typeof body.imageGenApiKey === "string" ? body.imageGenApiKey : "";
  if (submittedImageKey && !isMaskedApiKey(submittedImageKey)) {
    imageGenApiKey = submittedImageKey;
  } else {
    imageGenApiKey = current.imageGenApiKey;
  }

  // Validate image gen fields when enabling the image override.
  if (imageGenEnabled) {
    if (!imageGenApiKey.trim()) {
      sendJson(res, 200, { ok: false, error: "Image gen override aktif tapi API key kosong." });
      return;
    }
  }

  // ── Enabled-tools override fields (preserve current when absent) ──
  const toolsOverride =
    body.toolsOverride === undefined
      ? current.toolsOverride
      : body.toolsOverride === true || body.toolsOverride === "true";
  // enabledTools: accept a string (comma-separated) or an array of strings.
  let enabledTools: string;
  if (Array.isArray(body.enabledTools)) {
    enabledTools = body.enabledTools.filter((t) => typeof t === "string" && t.trim()).join(",");
  } else if (typeof body.enabledTools === "string") {
    enabledTools = body.enabledTools;
  } else {
    enabledTools = current.enabledTools;
  }

  const settings: TelegramAiSettings = {
    enabled,
    provider,
    customProviderName: customProviderName.trim(),
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    apiKey,
    customDefaultModel: customDefaultModel.trim(),
    updatedAt: "",
    imageGenEnabled,
    imageGenProvider: imageGenProvider.trim(),
    imageGenApiKey,
    imageGenModel: imageGenModel.trim(),
    imageGenBaseUrl: imageGenBaseUrl.trim().replace(/\/+$/, ""),
    toolsOverride,
    enabledTools,
  };

  try {
    await applyAiSettings(settings);
    sendJson(res, 200, {
      ok: true,
      settings: {
        ...settings,
        apiKey: maskApiKey(settings.apiKey),
        hasApiKey: settings.apiKey.length > 0,
        imageGenApiKey: maskApiKey(settings.imageGenApiKey),
        hasImageGenApiKey: settings.imageGenApiKey.length > 0,
      },
    });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err as Error).message });
  }
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

/**
 * Extract the session token from a request. Checks, in order:
 * 1. `Authorization: Bearer <token>` header (sent by the dashboard's fetch calls)
 * 2. `admin_session` cookie (sent automatically by the browser on EVERY request,
 *    including page navigation — this is what makes the post-login reload work,
 *    since navigation requests can't carry custom headers)
 */
function extractSessionToken(req: IncomingMessage): string | null {
  // 1. Authorization header (fetch calls from the dashboard JS).
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim() || null;
  }
  // 2. Cookie (page navigations / reloads — browsers send these automatically).
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === "string") {
    for (const part of cookieHeader.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === "admin_session" && v.length > 0) {
        return decodeURIComponent(v.join("="));
      }
    }
  }
  return null;
}

/**
 * Build a Set-Cookie header value for the session token. HttpOnly prevents JS
 * access (defense in depth), SameSite=Lax allows top-level navigation, and the
 * path is scoped to "/" so the cookie is sent on every route. Not Secure
 * because the service binds to 127.0.0.1 (plain HTTP localhost).
 */
function sessionCookie(token: string): string {
  return `admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}

/** Cookie value that clears the session cookie (logout). */
function clearSessionCookie(): string {
  return "admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
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
