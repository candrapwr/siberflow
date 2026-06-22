import { fork } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Tool } from "../base.js";
import { ensureChromium } from "./ensure-chromium.js";

/**
 * Resolve the absolute path to playwright-core's main module. The worker runs
 * from a temp dir (no node_modules there), so it must import playwright-core
 * by absolute path — we resolve it here and inject into the worker source.
 *
 * We deliberately avoid `import.meta.url` so esbuild can bundle into CJS
 * (the VSCode extension) without warnings: in a bundled CJS file,
 * import.meta.url is empty, and resolving playwright-core relative to it
 * would fail. Instead we anchor resolution to the user's working directory,
 * which always has node_modules reachable (either the repo root for CLI /
 * dev, or the package install dir for the bundled VSCode extension).
 */
function resolvePlaywrightCorePath(): string {
  // Build a CommonJS require anchored at the cwd's package.json. createRequire
  // works under real ESM and is preserved by esbuild's CJS output.
  const r = createRequire(pathToFileURL(join(process.cwd(), "package.json")).href);
  return r.resolve("playwright-core");
}

interface Args {
  script: string;
  url?: string;
  timeoutMs?: number;
}

/** Default and hard cap for a single scrape, in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
/** Truncate the result so a giant HTML dump doesn't blow up the context. */
const MAX_OUTPUT = 200_000;
/** Stable temp path for the worker module. Written once, reused. */
const WORKER_PATH = join(tmpdir(), "siberflow-scrape-worker.mjs");

/**
 * Worker source — runs in an isolated child process (spawned via fork()).
 *
 * Why a separate process instead of running Playwright in-process?
 *  1. Playwright is async-only and launches a real Chromium subprocess, which
 *     can hang or leak. A child process is the cleanest isolation boundary.
 *  2. A runaway script (infinite loop, never-resolving wait) can be killed
 *     wholesale via process-tree kill.
 *  3. The host (CLI / Electron main / VSCode ext host) stays responsive even
 *     while a 30-second scrape is running.
 *
 * Protocol (IPC):
 *   parent → child: { script, url, timeoutMs }
 *   child  → parent: { ok: true, result: string } | { ok: false, error: string }
 *
 * The worker is trusted (it only ever receives scripts the agent loop chose
 * to run), so `eval` here is acceptable — it's not the security boundary;
 * the process isolation is.
 *
 * This source is embedded as a string (rather than a separate .mjs file on
 * disk) so that it works identically whether core is loaded as real ESM
 * (CLI / desktop) or bundled into a CJS extension (VSCode) — in the latter,
 * `import.meta.url` is unavailable, so locating a sibling file would break.
 * We write it to a temp path once on first use and fork that.
 *
 * The __PLAYWRIGHT_CORE_PATH__ placeholder is replaced with the absolute path
 * to playwright-core on this machine at worker-write time. The temp dir has
 * no node_modules, so a bare `import "playwright-core"` would fail — we
 * import by absolute path instead.
 */
function buildWorkerSource(): string {
  const pwPath = resolvePlaywrightCorePath();
  return `
import playwrightCore from ${JSON.stringify(`file://${pwPath}`)};
const { chromium } = playwrightCore;
const parent = process;
parent.on("message", async (msg) => {
  const { script, url, timeoutMs } = msg;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    if (url && typeof url === "string" && url.length > 0) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs || 30000 });
    }
    const fn = eval(script);
    if (typeof fn !== "function") throw new Error("script must evaluate to a function");
    const result = await fn({ page, browser });
    const payload = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    parent.send({ ok: true, result: payload });
  } catch (err) {
    parent.send({ ok: false, error: (err && err.message) ? err.message : String(err) });
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    parent.exit(0);
  }
});
// Self-terminate if the parent never sends a message (e.g. it died).
setTimeout(() => parent.exit(0), 5 * 60 * 1000).unref();
`;
}

/** Write the worker module to a stable temp path (idempotent). */
function ensureWorkerFile(): void {
  // Rebuild the source each call in case the playwright-core install moved
  // (cheap, ~2KB string). The write itself is skipped if the content matches
  // the on-disk file.
  const source = buildWorkerSource();
  try {
    if (existsSync(WORKER_PATH)) {
      const existing = readFileSync(WORKER_PATH, "utf8");
      if (existing === source) return;
    }
  } catch {
    // ignore read errors — just overwrite
  }
  try {
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(WORKER_PATH, source, "utf8");
  } catch {
    // Race with a concurrent call — if the file now exists, we're fine.
    if (!existsSync(WORKER_PATH)) throw new Error("failed to write scrape worker to temp dir");
  }
}

export const webScrapeTool: Tool = {
  name: "web_scrape",
  description:
    "Scrape or interact with a web page using a headless Chromium browser via the Playwright API. " +
    "Use this when a page loads its content via JavaScript/AJAX (so a plain fetch returns an empty shell), " +
    "when you need to click a button / fill a form / log in before reading the page, or when you need to " +
    "wait for a selector to appear. The page is a real browser context, so anything a user can do in a " +
    "browser you can script here.\n\n" +
    "PARAMETERS:\n" +
    "- `script`: an async function expression taking ({ page, browser }). `page` is a Playwright Page " +
    "(already navigated to `url` if provided), `browser` is the Browser. Use Playwright methods like " +
    "page.click(), page.fill(), page.waitForSelector(), page.$$eval(), page.content(), page.screenshot(). " +
    "Return a string (or any JSON-serializable value) — it becomes the tool result.\n" +
    "- `url` (optional): navigate here before the script runs. Omit it if the script navigates itself.\n" +
    "- `timeoutMs` (optional, default 30000, max 60000): overall wall-clock cap including navigation.\n\n" +
    "EXAMPLES:\n" +
    '  Scrape items from an AJAX-loaded list:  "async ({ page }) => (await page.$$eval(\'.item\', els => els.map(e => e.textContent.trim())))"\n' +
    '  Click load-more then read:  "async ({ page }) => { await page.click(\'button.more\'); await page.waitForSelector(\'.loaded\'); return await page.$$eval(\'.row\', rs => rs.map(r => r.textContent)); }"\n' +
    '  Screenshot to project dir:  "async ({ page }) => { await page.screenshot({ path: \'shot.png\', fullPage: true }); return \'saved\'; }"\n\n' +
    "NOTES:\n" +
    "- Prefer extracting just the data you need (via $$eval/textContent) over returning full HTML — the " +
    "output is capped at 200KB to protect the context window.\n" +
    "- The script runs in an isolated child process with a hard timeout; a hang or infinite loop is killed " +
    "and surfaced as an error you can fix and retry.\n" +
    "- On first use, Chromium (~150MB) is downloaded once to the OS cache if not already present.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Initial URL to navigate to before the script runs. Omit if the script navigates itself.",
      },
      script: {
        type: "string",
        description:
          'An async function expression taking ({ page, browser }). Mutate/drive `page` and return a string ' +
          'or JSON value. Example: "async ({ page }) => await page.title()"',
      },
      timeoutMs: {
        type: "integer",
        description: "Overall timeout in ms (default 30000, max 60000).",
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async execute(args) {
    const parsed = parseArgs(args);

    // First-use download of the browser binary. Cheap when already present.
    await ensureChromium();
    // Materialize the worker module to a temp path (once), then fork it.
    ensureWorkerFile();

    const result = await runWorker(parsed);
    return truncate(result, MAX_OUTPUT);
  },
};

/** Validate the tool args. `script` is required; `url` and `timeoutMs` optional. */
function parseArgs(args: unknown): Args {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const script = input.script;
  if (typeof script !== "string" || script.trim() === "") {
    throw new Error("`script` is required and must be a non-empty string");
  }

  let url: string | undefined;
  if (input.url !== undefined) {
    if (typeof input.url !== "string" || input.url.trim() === "") {
      throw new Error("`url` must be a non-empty string when provided");
    }
    url = input.url;
  }

  let timeoutMs: number | undefined;
  if (input.timeoutMs !== undefined) {
    const n = input.timeoutMs;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1000) {
      throw new Error("`timeoutMs` must be a number >= 1000");
    }
    timeoutMs = Math.min(Math.floor(n), MAX_TIMEOUT_MS);
  }

  return { script, ...(url ? { url } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
}

interface WorkerResult {
  ok: boolean;
  result?: string;
  error?: string;
}

/**
 * Fork the worker process, send it the script, and await its reply.
 *
 * The worker is killed if it doesn't respond within the timeout — protecting
 * against scripts that hang on a never-appearing selector or an infinite
 * loop. We also kill the whole process tree (not just the direct child)
 * because Chromium spawns its own subprocesses.
 */
function runWorker(args: Args): Promise<string> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // Minimal env: don't leak secrets to the worker. Playwright needs PATH to
    // find the browser; keep a handful of essentials.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };

    const child = fork(WORKER_PATH, [], {
      // IPC channel (fd 3) is mandatory for fork()'s message passing; the
      // first three stdio slots are stdin/stdout/stderr. We keep stdout for
      // debug, pipe stderr for error context, and ignore stdin.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
      // Strip the parent's execArgv (e.g. --input-type=module from a `node -e`
      // wrapper) so it doesn't get re-applied to the worker .mjs file and
      // trip ERR_INPUT_TYPE_NOT_ALLOWED. The .mjs extension already selects
      // ESM mode; no flags needed.
      execArgv: [],
    });

    let stderrBuffer = "";
    child.stdout?.on("data", () => { /* discard worker stdout */ });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000);
    });

    // A promise can only settle once. All paths funnel through this guard so
    // a late `exit` after a successful `message` doesn't throw an unhandled
    // rejection.
    let settled = false;
    const settle = (errOrResult: Error | string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (errOrResult instanceof Error) reject(errOrResult);
      else resolve(errOrResult);
    };

    const timer = setTimeout(() => {
      killTree(child.pid!);
      settle(new Error(`web_scrape timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("message", (msg: WorkerResult) => {
      if (msg.ok && typeof msg.result === "string") {
        settle(msg.result);
      } else {
        const detail = msg.error ?? "unknown worker error";
        settle(new Error(stderrBuffer ? `${detail}\n--- worker stderr ---\n${stderrBuffer}` : detail));
      }
    });

    child.on("exit", (code, signal) => {
      // Only treat a raw exit as an error if we never got a message — a
      // normal post-message exit (code 0) is expected.
      if (code === 0 && settled) return;
      settle(
        new Error(
          `worker exited unexpectedly (code=${code}, signal=${signal})` +
            (stderrBuffer ? `\n--- worker stderr ---\n${stderrBuffer}` : ""),
        ),
      );
    });

    child.on("error", (err) => {
      settle(new Error(`failed to start scrape worker: ${err.message}`));
    });

    // Kick off the work. Send only the validated args.
    child.send({
      script: args.script,
      ...(args.url ? { url: args.url } : {}),
      timeoutMs,
    });
  });
}

/** Kill a process and its entire tree (Chromium spawns helper processes). */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      // Windows: taskkill with /T kills the whole tree.
      import("node:child_process").then(({ spawn }) =>
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }),
      );
    } else {
      // Unix: negative pid kills the whole process group (we forked detached).
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Best-effort — the worker may already be gone.
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
}

/** Cap output length with a truncation marker, mirroring exec / db_query. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}
