import { spawn } from "node:child_process";
import type { Tool } from "../base.js";

interface Args {
  command: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const FORCE_KILL_GRACE_MS = 5_000;
/** Safety cap when pre-truncation is OFF (status quo). */
const MAX_OUTPUT_RAW = 200_000;
/** Leaner cap when pre-truncation is ON (default) — keeps context small. */
const MAX_OUTPUT_PRE_TRUNCATE = 20_000;

export const execTool: Tool = {
  name: "exec",
  description:
    "Run a shell command, with working directory set to the project directory. Uses the platform shell (/bin/sh on Unix, cmd.exe on Windows). Returns stdout + stderr. By default output is capped to ~20K chars (pre-truncation) to keep context lean; disable via SIBERFLOW_PRE_TRUNCATE=false for the raw ~200KB cap. Note: shell commands can technically access paths outside the project — use container isolation for hard sandboxing.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout_ms: {
        type: "integer",
        description: `Timeout in ms (default ${DEFAULT_TIMEOUT}, max 600000)`,
        minimum: 1,
        maximum: 600_000,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { command, timeout_ms } = args as Args;
    const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT, 600_000);
    const maxOutput = ctx.preTruncate !== false ? MAX_OUTPUT_PRE_TRUNCATE : MAX_OUTPUT_RAW;

    // Pick the platform shell. Unix uses /bin/sh; Windows uses cmd.exe.
    const isWin = process.platform === "win32";
    const shell = isWin ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

    return await new Promise<string>((resolvePromise) => {
      const child = spawn(shell, shellArgs, {
        cwd: ctx.projectDir,
        env: process.env,
        // detached creates a process group on Unix; ignored for kill on Windows
        // (we use taskkill there instead). Windows shells need windowsHide.
        detached: !isWin,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;
      let forceKilled = false;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const timer = setTimeout(() => {
        killed = true;
        killProcess(child, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            forceKilled = true;
            killProcess(child, "SIGKILL");
          }
        }, FORCE_KILL_GRACE_MS);
      }, timeout);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < maxOutput) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < maxOutput) stderr += chunk.toString("utf8");
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        const parts: string[] = [];
        if (killed) parts.push(`(killed after ${timeout}ms timeout)`);
        if (forceKilled) {
          parts.push(
            `(force-killed with SIGKILL after ${FORCE_KILL_GRACE_MS}ms grace period)`,
          );
        }
        parts.push(`exit code: ${code ?? "null"}`);
        if (stdout) parts.push(`--- stdout ---\n${truncate(stdout, maxOutput)}`);
        if (stderr) parts.push(`--- stderr ---\n${truncate(stderr, maxOutput)}`);
        resolvePromise(parts.join("\n"));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise(`spawn error: ${err.message}`);
      });
    });
  },
};

/** Kill the spawned process tree. On Unix we kill the process group via the
 * negative pid; on Windows we shell out to `taskkill /T` which kills the
 * process and all its children. The signal argument is ignored on Windows. */
function killProcess(child: { pid?: number }, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    // taskkill /PID <pid> /T /F — kill the tree, force. Best-effort; ignore errors.
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // best-effort
    }
    return;
  }

  try {
    process.kill(-pid, signal); // kill the process group
    return;
  } catch {
    // Fall back to the direct child if process-group kill is unavailable.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // best-effort
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const skipped = s.length - max;
  return `${s.slice(0, max)}\n... [truncated ${skipped} bytes. To see the next chunk, re-run with \`| tail -c +${max + 2}\`, or grep/pipe for specific lines.]`;
}
