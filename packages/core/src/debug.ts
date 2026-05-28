function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Verbose tracing to stderr, gated by SIBERFLOW_DEBUG=true. Checked per call
 * (not at import) so it works regardless of when .env is loaded. Writes to
 * stderr so it never mixes with the streamed assistant output on stdout.
 */
export function debug(...args: unknown[]): void {
  if (process.env.SIBERFLOW_DEBUG !== "true") return;
  process.stderr.write(`\x1b[2m[siberflow]\x1b[0m ${args.map(fmt).join(" ")}\n`);
}

export function isDebug(): boolean {
  return process.env.SIBERFLOW_DEBUG === "true";
}
