import { fork } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Tool } from "../base.js";

interface Args {
  script: string;
  url?: string;
  timeoutMs?: number;
}

/** Default and hard cap for a single browser run, in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
/** Truncate the result so a giant HTML dump doesn't blow up the context. */
const MAX_OUTPUT = 200_000;
/** Stable temp path for the worker module. Written once, reused. */
const WORKER_PATH = join(tmpdir(), "siberflow-browser-worker.mjs");

/**
 * Resolve the absolute path to puppeteer-core's main module. The worker runs
 * from a temp dir (no node_modules there), so it must import puppeteer-core by
 * absolute path. We try multiple base dirs to cover CLI / Desktop (Electron) /
 * VSCode (bundled CJS) deployments.
 *
 * In a packaged Electron app the layout is:
 *   Siberflow.app/Contents/MacOS/Siberflow      (process.execPath)
 *   Siberflow.app/Contents/Resources/           (process.resourcesPath)
 *   Siberflow.app/Contents/Resources/app/       (asar:false app root)
 *   Siberflow.app/Contents/Resources/app/node_modules/puppeteer-core
 *
 * `require.resolve` with `paths` walks UP from each candidate looking for a
 * `node_modules` dir. Since the app root is `Resources/app` (not `Resources`
 * itself), we must include `Resources/app` as a candidate explicitly — walking
 * up from `Resources` would skip the `app/node_modules` subtree.
 */
function resolvePuppeteerCorePath(): string {
  try {
    const r = createRequire(pathToFileURL(join(process.cwd(), "package.json")).href);
    return r.resolve("puppeteer-core");
  } catch { /* fall through */ }

  const candidates: string[] = [process.cwd()];
  if (process.execPath) candidates.push(dirname(process.execPath));
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    candidates.push(resourcesPath);
    // Electron app root — where the unpacked node_modules live.
    candidates.push(join(resourcesPath, "app"));
    candidates.push(join(resourcesPath, "app", "node_modules"));
  }

  const entry = findPuppeteerCoreEntry(candidates);
  if (entry) return entry;

  throw new Error(
    "could not locate puppeteer-core on disk. " +
      "Candidates tried: " +
      candidates.join(", "),
  );
}

/**
 * Find puppeteer-core's main entry by checking each candidate base dir for
 * node_modules/puppeteer-core, then reading the package.json "main" field.
 * This avoids createRequire/import.meta.url issues in packaged Electron apps.
 */
function findPuppeteerCoreEntry(paths: string[]): string | undefined {
  for (const rawBase of paths) {
    // Resolve to absolute — candidates from Electron resourcesPath are already
    // absolute, but defensive resolution handles relative paths in dev.
    const base = resolve(rawBase);
    // base itself might be a node_modules dir
    const candidates = [
      join(base, "puppeteer-core"),
      join(base, "node_modules", "puppeteer-core"),
    ];
    for (const pkgDir of candidates) {
      const pkgJsonPath = join(pkgDir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { main?: string };
        const entry = pkg.main ?? "lib/puppeteer/puppeteer-core.js";
        const fullPath = resolve(pkgDir, entry);
        if (existsSync(fullPath)) return fullPath;
        // Some versions use "cjs" entry
        const cjsEntry = join(pkgDir, "lib", "cjs", "puppeteer", "puppeteer-core.js");
        if (existsSync(cjsEntry)) return cjsEntry;
      } catch { /* skip broken package.json */ }
    }
  }
  return undefined;
}

/**
 * Worker source — runs in an isolated child process (forked). Launches the
 * user's installed Chrome/Edge via Puppeteer (channel: 'chrome' → fallback
 * 'msedge'). No Chromium is downloaded; the user must have Chrome or Edge.
 *
 * Protocol (IPC):
 *   parent → child: { script, url, timeoutMs }
 *   child  → parent: { ok: true, result } | { ok: false, error }
 *
 * The worker is embedded as a string (not a separate .mjs file) so it works
 * whether core is loaded as real ESM (CLI/desktop) or bundled into CJS
 * (VSCode extension). The puppeteer-core absolute path is injected at the
 * host so the temp-dir worker can resolve it.
 */
function buildWorkerSource(): string {
  const ppPath = resolvePuppeteerCorePath();
  return `
import puppeteer from ${JSON.stringify(`file://${ppPath}`)};
const parent = process;

async function launchBrowser() {
  // Try Chrome first, then Edge. If neither is installed, throw a clear message.
  const channels = ["chrome", "msedge"];
  let lastErr;
  for (const channel of channels) {
    try {
      return await puppeteer.launch({ channel, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("Chrome/Edge tidak ditemukan di sistem. Install Google Chrome atau Microsoft Edge untuk pakai run_browser. (" + (lastErr && lastErr.message ? lastErr.message : "unknown error") + ")");
}

parent.on("message", async (msg) => {
  const { script, url, timeoutMs } = msg;
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    if (url && typeof url === "string" && url.length > 0) {
      await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs || 30000 });
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
setTimeout(() => parent.exit(0), 5 * 60 * 1000).unref();
`;
}

/** Write the worker module to a stable temp path (idempotent). */
function ensureWorkerFile(): void {
  const source = buildWorkerSource();
  try {
    if (existsSync(WORKER_PATH)) {
      const existing = readFileSync(WORKER_PATH, "utf8");
      if (existing === source) return;
    }
  } catch { /* ignore */ }
  try {
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(WORKER_PATH, source, "utf8");
  } catch {
    if (!existsSync(WORKER_PATH)) throw new Error("failed to write browser worker to temp dir");
  }
}

export const runBrowserTool: Tool = {
  name: "run_browser",
  description:
    "Launch a real headless Chrome/Edge browser and run any Puppeteer code you write. " +
    "You get full control — navigate, click, type, wait, evaluate, screenshot, intercept " +
    "network, manage cookies, open multiple tabs, download files, fill & submit forms, " +
    "log in, test flows, extract data, generate PDFs, etc. Essentially anything a human " +
    "can do in a browser, you can automate here.\n\n" +
    "You receive `{ page, browser }`: `page` is a Puppeteer Page already navigated to `url` " +
    "(if you provided one); `browser` is the Browser instance so you can open more pages. " +
    "Write Puppeteer API calls freely. Return a string or any JSON-serializable value — " +
    "that becomes the tool result shown to you.\n\n" +
    "TIPS:\n" +
    "- The browser is the user's installed Chrome or Edge (no separate download).\n" +
    "- If a site needs login, you can fill the form and submit it within the script.\n" +
    "- Use page.waitForSelector() for content that appears after JS/AJAX runs.\n" +
    "- Use page.$$eval() to extract arrays of data from matched elements.\n" +
    "- IMPORTANT: `page.waitForTimeout(ms)` was REMOVED in Puppeteer v22+. To " +
    "sleep, use `await new Promise(r => setTimeout(r, ms))` instead.\n" +
    "- Prefer waiting for a specific selector over a fixed sleep whenever possible.\n" +
    "- You are free to use any Puppeteer method — the sandbox is isolated per call.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Optional initial URL to navigate to before the script runs. Omit if the script handles navigation itself." },
      script: {
        type: "string",
        description:
          'An async function expression receiving ({ page, browser }). Write any Puppeteer code. ' +
          'Example: "async ({ page, browser }) => { await page.goto(\'https://example.com\'); return await page.title(); }"',
      },
      timeoutMs: { type: "integer", description: "Optional overall timeout in ms (default 30000, max 60000).", minimum: 1000, maximum: MAX_TIMEOUT_MS },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async execute(args) {
    const parsed = parseArgs(args);
    ensureWorkerFile();
    const result = await runWorker(parsed);
    return truncate(result, MAX_OUTPUT);
  },
};

function parseArgs(args: unknown): Args {
  if (!args || typeof args !== "object") throw new Error("arguments must be an object");
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

function runWorker(args: Args): Promise<string> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PROGRAMFILES: process.env.PROGRAMFILES,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    const child = fork(WORKER_PATH, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
      execArgv: [],
    });

    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000);
    });

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
      settle(new Error(`run_browser timed out after ${timeoutMs}ms`));
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
      if (code === 0 && settled) return;
      settle(
        new Error(
          `worker exited unexpectedly (code=${code}, signal=${signal})` +
            (stderrBuffer ? `\n--- worker stderr ---\n${stderrBuffer}` : ""),
        ),
      );
    });

    child.on("error", (err) => settle(new Error(`failed to start browser worker: ${err.message}`)));

    child.send({ script: args.script, ...(args.url ? { url: args.url } : {}), timeoutMs });
  });
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      import("node:child_process").then(({ spawn }) =>
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }),
      );
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}
