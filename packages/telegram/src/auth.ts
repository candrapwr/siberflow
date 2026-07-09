/**
 * Telegram admin web authentication.
 *
 * Out-of-band OTP login: the web UI shows a short code; an admin sends
 * `/login <code>` to the bot in a private chat. The bot verifies the admin
 * status and the code, then issues a session token that the web UI stores in
 * localStorage and sends on every request. This keeps secrets out of URLs and
 * server logs (unlike the old `?token=` scheme).
 *
 * Two pending-code slots are kept so a second device can start a login without
 * invalidating the first in-progress code. Codes expire after 10 minutes.
 */
import { randomBytes } from "node:crypto";

/** A pending login code awaiting admin approval. */
interface PendingLogin {
  /** The 6-char alphanumeric code shown in the web UI. */
  code: string;
  /** ISO timestamp when the code was issued. */
  createdAt: number;
}

/** An approved web session. */
interface WebSession {
  /** Opaque session token (hex) stored in the browser. */
  token: string;
  /** Telegram user id of the admin who approved this session. */
  adminUserId: number;
  /** ISO timestamp of issuance; for expiry checks. */
  createdAt: number;
}

const CODE_TTL_MS = 10 * 60_000; // 10 minutes
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O/1/I)
const CODE_LENGTH = 6;
const MAX_PENDING = 2;

/** Pending login codes, newest first. */
const pendingLogins: PendingLogin[] = [];
/** Approved sessions keyed by token. */
const sessions = new Map<string, WebSession>();
/** Maps a consumed login code to the session token it minted, for polling. */
const codeToToken = new Map<string, string>();

/** Generate a human-friendly 6-char code (no ambiguous chars). */
function generateCode(): string {
  let code = "";
  const bytes = randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/** Generate an opaque hex session token. */
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** Drop expired pending codes. */
function pruneExpired(): void {
  const now = Date.now();
  while (pendingLogins.length > 0 && now - pendingLogins[0]!.createdAt > CODE_TTL_MS) {
    pendingLogins.shift();
  }
}

/**
 * Start a new login flow. Returns a fresh code to display in the web UI. The
 * caller polls {@link pollLogin} until the admin approves it (or it expires).
 */
export function startLogin(): string {
  pruneExpired();
  // Avoid collisions with any still-valid pending code.
  let code: string;
  do {
    code = generateCode();
  } while (pendingLogins.some((p) => p.code === code));
  pendingLogins.unshift({ code, createdAt: Date.now() });
  // Cap the number of in-flight codes.
  if (pendingLogins.length > MAX_PENDING) {
    pendingLogins.length = MAX_PENDING;
  }
  return code;
}

/**
 * Called from the `/login <code>` command handler. Validates the code, and if
 * it matches a pending login, issues a session token bound to the admin.
 * Returns `{ ok, token? }` — `ok: false` means the code was wrong/expired.
 * The code→token mapping is recorded so the web UI's poll can find the token.
 */
export function approveLogin(
  code: string,
  adminUserId: number,
): { ok: boolean; token?: string } {
  pruneExpired();
  const upper = code.trim().toUpperCase();
  const idx = pendingLogins.findIndex((p) => p.code === upper);
  if (idx === -1) return { ok: false };
  pendingLogins.splice(idx, 1);
  const token = generateSessionToken();
  sessions.set(token, { token, adminUserId, createdAt: Date.now() });
  codeToToken.set(upper, token);
  return { ok: true, token };
}

/**
 * Poll a login code's status. Used by the web UI in a tight loop after showing
 * a code.
 */
export function pollLogin(code: string): {
  status: "pending" | "approved" | "expired";
  token?: string;
} {
  pruneExpired();
  const upper = code.trim().toUpperCase();
  const token = codeToToken.get(upper);
  if (token && sessions.has(token)) {
    return { status: "approved", token };
  }
  // If the code is still pending, the admin hasn't approved it yet.
  if (pendingLogins.some((p) => p.code === upper)) {
    return { status: "pending" };
  }
  // Not pending and not approved → expired or never existed.
  return { status: "expired" };
}

/** Verify a session token. Returns the admin user id if valid, else null. */
export function verifySession(token: string): number | null {
  const session = sessions.get(token);
  if (!session) return null;
  return session.adminUserId;
}

/** Revoke a session (logout). */
export function revokeSession(token: string): void {
  sessions.delete(token);
  // Clean up any code→token mapping pointing at it.
  for (const [code, t] of codeToToken) {
    if (t === token) {
      codeToToken.delete(code);
    }
  }
}
