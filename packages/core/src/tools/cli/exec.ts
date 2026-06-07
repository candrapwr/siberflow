import { spawn } from "node:child_process";
import type { Tool } from "../base.js";

interface Args {
  command: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const FORCE_KILL_GRACE_MS = 5_000;
const MAX_OUTPUT = 200_000;

export const execTool: Tool = {
  name: "exec",
  description:
    "Run a shell command via `/bin/sh -c`, with working directory set to the project directory. Returns stdout + stderr (truncated to ~200KB). Note: shell commands can technically access paths outside the project — use container isolation for hard sandboxing.",
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

    return await new Promise<string>((resolvePromise) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: ctx.projectDir,
        env: process.env,
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;
      let forceKilled = false;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const timer = setTimeout(() => {
        killed = true;
        killProcessGroup(child.pid, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            forceKilled = true;
            killProcessGroup(child.pid, "SIGKILL");
          }
        }, FORCE_KILL_GRACE_MS);
      }, timeout);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
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
        if (stdout) parts.push(`--- stdout ---\n${truncate(stdout)}`);
        if (stderr) parts.push(`--- stderr ---\n${truncate(stderr)}`);
        resolvePromise(parts.join("\n"));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise(`spawn error: ${err.message}`);
      });
    });
  },
};

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
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

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n... [truncated ${s.length - MAX_OUTPUT} bytes]`;
}
