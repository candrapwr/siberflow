import { fork, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Tool, ToolContext } from "../base.js";
import {
  assertNoLocalBrowserUrl,
  assertNoLocalUrlInScript,
  assertNoShellLikeScriptAccess,
} from "../script-safety.js";

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
 * absolute path. We try multiple strategies to cover CLI / Desktop (Electron) /
 * VSCode (bundled CJS) deployments.
 *
 * Resolution order:
 *   1. SIBERFLOW_PUPPETEER_CORE_PATH env var — explicit override. Used by the
 *      VSCode extension host, which resolves the path from its extensionPath
 *      (the install dir of the bundled puppeteer-core) and passes it down. This
 *      is the most reliable path because the host KNOWS where the extension
 *      lives; core alone cannot (process.execPath is the VSCode/Electron
 *      binary, not the extension).
 *   2. createRequire from cwd — works in CLI/monorepo dev (node_modules at
 *      project root) and when core is loaded as real ESM from its install dir.
 *   3. createRequire relative to THIS module — finds a sibling/hoisted
 *      node_modules regardless of cwd (covers packaged Electron apps where
 *      cwd is unrelated and the require.resolve paths scan would miss it).
 *   4. Manual scan of candidate base dirs — last-resort fallback that walks
 *      known deployment layouts (Electron resourcesPath, execPath dir).
 *
 * In a packaged Electron app the layout is:
 *   Siberflow.app/Contents/MacOS/Siberflow      (process.execPath)
 *   Siberflow.app/Contents/Resources/           (process.resourcesPath)
 *   Siberflow.app/Contents/Resources/app/       (asar:false app root)
 *   Siberflow.app/Contents/Resources/app/node_modules/puppeteer-core
 *
 * In a packaged VSCode extension the layout is:
 *   ~/.vscode/extensions/siberflow-<ver>/
 *     dist/extension.cjs
 *     node_modules/puppeteer-core/         ← shipped with the VSIX
 * The host resolves this path and passes it via the env var (step 1).
 */
function resolvePuppeteerCorePath(): string {
  // 1. Explicit override from the host (VSCode extension host).
  const envPath = process.env.SIBERFLOW_PUPPETEER_CORE_PATH;
  if (envPath && envPath.trim() !== "") {
    const entry = resolveEntryFrom(envPath);
    if (entry) return entry;
    // env override didn't resolve — fall through to the other strategies.
  }

  // 2. createRequire from cwd (CLI / dev / ESM install dir).
  try {
    const r = createRequire(pathToFileURL(join(process.cwd(), "package.json")).href);
    return r.resolve("puppeteer-core");
  } catch { /* fall through */ }

  // 3. createRequire relative to THIS module — cwd-independent. Covers
  //    packaged apps where cwd is unrelated to where node_modules lives.
  try {
    const r = createRequire(import.meta.url);
    return r.resolve("puppeteer-core");
  } catch { /* fall through */ }

  // 4. Manual scan of candidate base dirs (Electron layout fallback).
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
 * Given the puppeteer-core PACKAGE directory, read its package.json and return
 * the resolved main entry file. Tries the "main" field, then falls back to the
 * known CJS entry layout some versions use. Returns undefined if not found.
 */
function entryFromPkgDir(pkgDir: string): string | undefined {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { main?: string };
    const entry = pkg.main ?? "lib/puppeteer/puppeteer-core.js";
    const fullPath = resolve(pkgDir, entry);
    if (existsSync(fullPath)) return fullPath;
    // Some versions use a "cjs" entry layout.
    const cjsEntry = join(pkgDir, "lib", "cjs", "puppeteer", "puppeteer-core.js");
    if (existsSync(cjsEntry)) return cjsEntry;
  } catch { /* skip broken package.json */ }
  return undefined;
}

/**
 * Resolve puppeteer-core's main entry from a path supplied by the host. `base`
 * may be EITHER the puppeteer-core package directory itself (the common case —
 * the host resolves the package and passes it) OR a parent dir containing a
 * `node_modules/puppeteer-core` subtree. Returns undefined if not found.
 */
function resolveEntryFrom(base: string): string | undefined {
  const resolved = resolve(base);
  // Case 1: base IS the puppeteer-core package dir.
  const direct = entryFromPkgDir(resolved);
  if (direct) return direct;
  // Case 2: base is a parent (e.g. a node_modules dir).
  const asParent = entryFromPkgDir(join(resolved, "puppeteer-core"));
  if (asParent) return asParent;
  const asNodeModules = entryFromPkgDir(join(resolved, "node_modules", "puppeteer-core"));
  if (asNodeModules) return asNodeModules;
  return undefined;
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
    // base might be: a node_modules dir, a parent of puppeteer-core, or (rare)
    // the puppeteer-core pkg dir itself. Check all three layouts.
    const pkgDirs = [
      join(base, "puppeteer-core"),
      join(base, "node_modules", "puppeteer-core"),
      base, // base itself is the pkg dir
    ];
    for (const pkgDir of pkgDirs) {
      const entry = entryFromPkgDir(pkgDir);
      if (entry) return entry;
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
  const nmIdx = ppPath.lastIndexOf("node_modules");
  const nmDir = nmIdx === -1 ? "" : ppPath.substring(0, nmIdx + "node_modules".length);
  return `
// puppeteer-extra + stealth plugin for anti-detection (Google, CAPTCHA, etc.)
import puppeteer from ${JSON.stringify(`file://${ppPath}`)};
import { createRequire } from "module";
const _reqBrowser = createRequire(${JSON.stringify(nmDir + "/package.json")});
const puppeteerExtra = _reqBrowser("puppeteer-extra");
const StealthPlugin = _reqBrowser("puppeteer-extra-plugin-stealth");
puppeteerExtra.use(StealthPlugin());
const parent = process;
const forbiddenScriptPatterns = [
  ["child_process", /\\b(?:node:)?child_process\\b/],
  ["execSync", /\\bexecSync\\s*\\(/],
  ["execFileSync", /\\bexecFileSync\\s*\\(/],
  ["spawnSync", /\\bspawnSync\\s*\\(/],
  ["exec", /\\bexec\\s*\\(/],
  ["execFile", /\\bexecFile\\s*\\(/],
  ["spawn", /\\bspawn\\s*\\(/],
  ["fork", /\\bfork\\s*\\(/],
  ["require", /\\brequire\\s*\\(/],
  ["dynamic import", /\\bimport\\s*\\(/],
  ["process", /\\bprocess\\b/],
  ["new Function", /\\bnew\\s+Function\\s*\\(/],
  ["Function constructor", /\\bFunction\\s*\\(/],
  ["eval", /\\beval\\s*\\(/],
];

function assertNoShellLikeScriptAccess(script) {
  const hits = forbiddenScriptPatterns.filter(([, pattern]) => pattern.test(script)).map(([name]) => name);
  if (hits.length === 0) return;
  throw new Error(
    "run_browser blocked the script because shell/process access is not allowed here. " +
      "Forbidden usage detected: " + [...new Set(hits)].join(", ") + ". " +
      "Remove all child_process/exec/spawn/require/import/process/eval/Function usage. " +
      "Use only Puppeteer APIs and files inside the current workdir."
  );
}

async function launchBrowser() {
  // Try Chrome first, then Edge. If neither is installed, throw a clear message.
  const channels = ["chrome", "msedge"];
  let lastErr;
  for (const channel of channels) {
    try {
      // Using puppeteerExtra (with stealth plugin) to avoid anti-bot detection.
      // --no-zygote: Chrome normally forks a "zygote" helper that pre-spawns
      // renderers. With --no-zygote each renderer is a direct child of the
      // browser process, so killing the browser process reliably reaps all
      // children (no orphaned zygote/GPU/Crashpad processes = no zombies).
      // Combined with killTree() in the parent, this is what prevents the
      // "Chrome zombie" leak when a run_browser call times out or errors.
      return await puppeteerExtra.launch({ channel, headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--no-zygote"] });
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
    assertNoShellLikeScriptAccess(String(script || ""));
    browser = await launchBrowser();
    const page = await browser.newPage();

    // DEFENSE-IN-DEPTH: block any local scheme navigation at the network layer,
    // even if the script bypasses the regex safety check. file://, chrome://,
    // about:, devtools:// let the browser read/write HOST files outside the
    // project sandbox — this was a full-server compromise vector. We abort
    // every request whose URL does NOT start with http(s)://, ws(s)://, data:,
    // or blob: — those four are the only schemes needed for legitimate web
    // automation (pages, AJAX, WebSockets, in-page blobs/data). Everything
    // else (file://, chrome://, about:, devtools:, view-source:, ...) is
    // rejected because it exposes the host filesystem or browser internals.
    // NOTE: regexes here use new RegExp() with string patterns (not /.../ literals)
    // because this code is embedded in a template literal whose backslash/regex
    // escaping is fragile — string-form RegExp avoids that whole class of bugs.
    const allowedScheme = new RegExp("^(https?|wss?)://", "i");
    const allowedInline = new RegExp("^(data|blob):", "i");
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const u = req.url();
      if (allowedScheme.test(u) || allowedInline.test(u)) {
        req.continue();
      } else {
        req.abort("accessdenied");
      }
    });

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
    await closeBrowserSafely(browser);
    parent.exit(0);
  }
});

// Hard-cap the worker's lifetime. If the AI's script hangs forever (e.g. an
// infinite loop in page.evaluate, or a waitForSelector that never resolves),
// the parent's timeout + killTree should already have terminated us — but as
// a last-resort backstop we also self-exit. CRUCIALLY we close the browser
// first: process.exit() skips the finally{} above, so a raw exit here would
// orphan the Chrome process (zombie). The outer 'browser' variable is in the
// module scope (declared with 'let browser;' at the top of the handler), and
// this self-kill timer closes over it.
const selfKillTimer = setTimeout(async () => {
  await closeBrowserSafely(browser);
  parent.exit(0);
}, 5 * 60 * 1000);
selfKillTimer.unref();

// Also clean up if the parent process dies unexpectedly (e.g. SIGKILL'd by the
// host) — without this the worker + Chrome would be orphaned.
parent.on("disconnect", async () => {
  await closeBrowserSafely(browser);
  parent.exit(0);
});

async function closeBrowserSafely(b) {
  if (!b) return;
  try {
    // Graceful close first so Chrome tears down its child processes normally.
    await Promise.race([
      b.close(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch (e) {
    // If graceful close hangs/fails, force-kill via the process API. Puppeteer
    // exposes the spawned Chrome's pid; killing it directly also reaps the
    // GPU/renderer/helper children on Linux when --no-zygote is set (which we
    // pass in launchBrowser()).
    try {
      const proc = b.process ? b.process() : null;
      if (proc && typeof proc.kill === "function") proc.kill("SIGKILL");
    } catch (e2) {}
  }
}
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
    "Run Puppeteer code in a headless Chrome/Edge (the user's installed browser) with stealth anti-detection. " +
    "You receive `{ page, browser }` — `page` is navigated to `url` if provided; `browser` lets you open more pages. " +
    "Write any Puppeteer calls; return a string or JSON-serializable value.\n\n" +
    "Features:\n" +
    "- Stealth anti-detection (puppeteer-extra + stealth plugin) — Google, Bing, and most sites work without CAPTCHA.\n" +
    "- `page.waitForTimeout(ms)` was REMOVED in Puppeteer v22+ — sleep with " +
    "`await new Promise(r => setTimeout(r, ms))` instead.\n" +
    "- Prefer `page.waitForSelector()` / `page.$$eval()` over fixed sleeps for AJAX/SPA content.\n" +
    "- File paths (screenshot, downloads, setInputFiles) resolve relative to the PROJECT dir — use " +
    "relative paths, not absolute.\n" +
    "- Shell/process access is blocked (child_process, require, eval, etc.).",
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
  async execute(args, ctx) {
    const parsed = parseArgs(args);
    ensureWorkerFile();
    // Set the worker's cwd to the project sandbox so that relative paths the
    // AI writes inside the Puppeteer script (page.screenshot({ path: 'out.png' }),
    // downloads, setInputFiles, etc.) land in the project directory the user
    // expects — not an arbitrary host cwd (Electron's app dir, VSCode's
    // extension dir, etc.). Falls back to process.cwd() if no workdir.
    const result = await runWorker(parsed, ctx);
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
  assertNoShellLikeScriptAccess(script, "run_browser");
  // Block local browser URL schemes (file://, chrome://, about:, ...) that
  // would let the script read/write host files outside the project sandbox.
  // This is the primary guard; the script body is also scanned below.
  assertNoLocalUrlInScript(script, "run_browser");
  let url: string | undefined;
  if (input.url !== undefined) {
    if (typeof input.url !== "string" || input.url.trim() === "") {
      throw new Error("`url` must be a non-empty string when provided");
    }
    assertNoLocalBrowserUrl(input.url, "run_browser");
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

function runWorker(args: Args, ctx: ToolContext): Promise<string> {
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
      // detached: true makes the worker its OWN process-group leader. This is
      // what lets killTree() below (process.kill(-pid)) reach not just the
      // worker Node process but also the Chrome process(es) it spawned —
      // without it, Chrome runs in a different group and survives the kill,
      // leaking as a zombie. On Windows detached is ignored (taskkill /T is
      // used instead), so this is safe cross-platform.
      detached: true,
      // Run the worker from the project sandbox so relative file paths in the
      // Puppeteer script (screenshot output, downloads, file uploads) resolve
      // against the project dir, not the host's cwd.
      cwd: ctx.projectDir,
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
      // Windows: taskkill /T kills the whole process tree. Use spawnSync so the
      // kill completes before we return — the old code used a fire-and-forget
      // dynamic import().then(spawn) that could race the parent process.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      // Kill the worker's whole process GROUP (-pid). Because the worker is
      // forked with detached:true, it leads its own group that also contains
      // the Chrome process(es) it launched — so this single call reaps them all
      // and prevents zombie Chrome processes.
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Fallback: kill just the leader pid directly (group kill can fail if the
    // process already exited). Best-effort; combined with the worker's own
    // closeBrowserSafely() this still covers the common case.
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}
