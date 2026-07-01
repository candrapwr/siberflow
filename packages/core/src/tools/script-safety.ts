interface ForbiddenScriptPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

const FORBIDDEN_SCRIPT_PATTERNS: ForbiddenScriptPattern[] = [
  { name: "child_process", pattern: /\b(?:node:)?child_process\b/ },
  { name: "execSync", pattern: /\bexecSync\s*\(/ },
  { name: "execFileSync", pattern: /\bexecFileSync\s*\(/ },
  { name: "spawnSync", pattern: /\bspawnSync\s*\(/ },
  { name: "exec", pattern: /\bexec\s*\(/ },
  { name: "execFile", pattern: /\bexecFile\s*\(/ },
  { name: "spawn", pattern: /\bspawn\s*\(/ },
  { name: "fork", pattern: /\bfork\s*\(/ },
  { name: "require", pattern: /\brequire\s*\(/ },
  { name: "dynamic import", pattern: /\bimport\s*\(/ },
  { name: "process", pattern: /\bprocess\b/ },
  { name: "new Function", pattern: /\bnew\s+Function\s*\(/ },
  { name: "Function constructor", pattern: /\bFunction\s*\(/ },
  { name: "eval", pattern: /\beval\s*\(/ },
  // CDP methods that let the script write to the HOST filesystem outside the
  // project sandbox. This was the actual write-vector in the CVE-2026-31431
  // pretext compromise: the attacker used createCDPSession() +
  // Page.setDownloadBehavior to drop a sudoers file into /etc/sudoers.d/.
  // Filesystem access must stay restricted to the resolveWithin() sandbox.
  { name: "Page.setDownloadBehavior", pattern: /\bsetDownloadBehavior\b/ },
  { name: "Browser.setDownloadBehavior", pattern: /\bBrowser\.setDownloadBehavior\b/ },
  { name: "Page.setDownloadBehavior", pattern: /\bPage\.setDownloadBehavior\b/ },
  { name: "IO.read", pattern: /\bIO\.read\b/ },
  { name: "IO.write", pattern: /\bIO\.write\b/ },
  { name: "Page.printToPDF", pattern: /\bprintToPDF\b/ },
  // Runtime.evaluate via CDP can run arbitrary JS in the browser context with
  // node integration off, but block it as defense-in-depth (page.evaluate in
  // the page sandbox is the legit path; cdp Runtime.evaluate is a backdoor).
  { name: "Runtime.evaluate (CDP)", pattern: /\bRuntime\.evaluate\b/ },
];

export function assertNoShellLikeScriptAccess(
  script: string,
  toolName: string,
): void {
  const hits = FORBIDDEN_SCRIPT_PATTERNS
    .filter(({ pattern }) => pattern.test(script))
    .map(({ name }) => name);
  if (hits.length === 0) return;

  throw new Error(
    `${toolName} blocked the script because shell/process/CDP-filesystem access is not allowed here. ` +
      `Forbidden usage detected: ${[...new Set(hits)].join(", ")}. ` +
      "Remove all child_process/exec/spawn/require/import/process/eval/Function usage, " +
      "and do not use CDP methods that touch the host filesystem " +
      "(setDownloadBehavior, IO.read/write, Runtime.evaluate). " +
      "Use only the tool-provided APIs and files inside the current workdir.",
  );
}

/**
 * Local-access protocols that MUST be blocked in run_browser, because the
 * browser runs on the HOST machine (not inside the project sandbox) and these
 * schemes let the puppeteer script read/write arbitrary host files — bypassing
 * the resolveWithin() sandbox entirely. This was the vector for a full-server
 * compromise (CVE-2026-31431 pretext attack): `page.goto('file:///etc/passwd')`
 * leaked /etc/passwd, /etc/shadow, /etc/sudoers.d, SSH keys, and enabled
 * writing to /etc/cron.d + /etc/sudoers.d for persistence. HTTP(S) remains the
 * only allowed scheme; everything else is rejected.
 */
const FORBIDDEN_URL_SCHEMES = [
  "file:",
  "chrome:",
  "chrome-extension:",
  "about:",
  "devtools:",
  "view-source:",
];

/**
 * Reject any local/internal browser URL scheme. HTTP(S) and bare host/path
 * URLs are allowed; file://, chrome://, about: etc. are blocked because they
 * expose the host filesystem / browser internals outside the project sandbox.
 */
export function assertNoLocalBrowserUrl(url: string, toolName: string): void {
  const trimmed = url.trim().toLowerCase();
  const hit = FORBIDDEN_URL_SCHEMES.find((scheme) => trimmed.startsWith(scheme));
  if (!hit) return;
  throw new Error(
    `${toolName} blocked the URL because the "${hit}" scheme is not allowed. ` +
      "Only http(s):// URLs are permitted. file://, chrome://, about:, and other local " +
      "schemes are blocked to prevent access to host files outside the session workdir.",
  );
}

/**
 * Scan a puppeteer script body for any attempt to use a forbidden local URL
 * scheme inside page.goto(), fetch(), or string literals. This is a defense-
 * in-depth layer: the primary guard is assertNoLocalBrowserUrl() on the `url`
 * arg, but the script can also navigate internally (page.goto('file:///etc/...'))
 * so we pattern-match the script too. False negatives are possible with heavy
 * obfuscation, but combined with the URL guard this closes the known
 * compromise path.
 */
export function assertNoLocalUrlInScript(script: string, toolName: string): void {
  // Patterns match the scheme followed by 1-3 slashes (file:/, file://, file:///)
  // so we catch navigation calls. We avoid matching the bare word (e.g. "file:")
  // to reduce false positives on normal text that mentions these words.
  const schemePatterns: Record<string, RegExp> = {
    "file:": /\bfile:[/]{1,3}/i,
    "chrome:": /\bchrome:[/]{0,3}/i,
    "chrome-extension:": /\bchrome-extension:[/]{0,3}/i,
    "about:": /\babout:[/]{0,3}(?!\/\/)/i,
    "devtools:": /\bdevtools:[/]{0,3}/i,
    "view-source:": /\bview-source:[/]{0,3}/i,
  };
  for (const [scheme, pattern] of Object.entries(schemePatterns)) {
    if (pattern.test(script)) {
      throw new Error(
        `${toolName} blocked the script because it references the "${scheme}" scheme. ` +
          "Local browser schemes (file://, chrome://, about:) are not allowed inside scripts — " +
          "they expose host files outside the session workdir. Use only http(s):// URLs.",
      );
    }
  }
}
