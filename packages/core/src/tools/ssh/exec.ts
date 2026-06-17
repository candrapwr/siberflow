import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { Tool } from "../base.js";

interface Args {
  host: string;
  user: string;
  password?: string;
  privateKey?: string;
  port?: number;
  command: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_OUTPUT = 200_000;

/**
 * ssh_exec — run a command on a remote host over SSH. One-shot: connects,
 * runs ONE command, captures stdout/stderr + exit code, disconnects.
 *
 * Auth (choose one):
 *   - password: cleartext password (accepted as an argument, same pattern as
 *     db_query — be aware it enters the conversation history / session file).
 *   - privateKey: PEM-formatted private key string (also enters history; for
 *     keys on disk, prefer configuring the system ssh agent / ~/.ssh instead).
 *
 * NOTE: there is NO sandbox. The command runs with the privileges of `user`
 * on the remote host. Prefer least-privilege accounts for this tool.
 */
export const sshExecTool: Tool = {
  name: "ssh_exec",
  description:
    "Run a shell command on a REMOTE host via SSH (one-shot: connects, runs one command, captures output, disconnects). " +
      "Provide host + user + (password OR privateKey). Returns stdout, stderr, and the remote exit code (truncated to ~200KB). " +
      "Use this for remote server administration: inspect logs, check disk/processes, restart services. " +
      "Note: there is no sandbox — the command runs as the given remote user with full privileges.",
  parameters: {
    type: "object",
    properties: {
      host: {
        type: "string",
        description: "Remote host (hostname or IP, without user@)",
      },
      user: {
        type: "string",
        description: "SSH login user on the remote host",
      },
      password: {
        type: "string",
        description: "SSH password (optional, use privateKey or system key as alternatives)",
      },
      privateKey: {
        type: "string",
        description: "PEM-format private key string (alternative to password)",
      },
      port: {
        type: "integer",
        description: "SSH port (default 22)",
        minimum: 1,
        maximum: 65535,
      },
      command: {
        type: "string",
        description: "Shell command to execute on the remote host",
      },
      timeout_ms: {
        type: "integer",
        description: `Timeout in ms (default ${DEFAULT_TIMEOUT}, max 600000)`,
        minimum: 1,
        maximum: 600_000,
      },
    },
    required: ["host", "user", "command"],
    additionalProperties: false,
  },
  async execute(args, _ctx) {
    const parsed = validateArgs(args);
    return await runRemoteCommand(parsed);
  },
};

function validateArgs(args: unknown): Args {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const command = requireString(input.command, "command");
  const host = requireString(input.host, "host");
  const user = requireString(input.user, "user");
  const password =
    typeof input.password === "string" && input.password.length > 0
      ? input.password
      : undefined;
  const privateKey =
    typeof input.privateKey === "string" && input.privateKey.length > 0
      ? input.privateKey
      : undefined;

  if (!password && !privateKey) {
    throw new Error("either `password` or `privateKey` must be provided");
  }

  const port =
    typeof input.port === "number" && Number.isFinite(input.port)
      ? input.port
      : undefined;
  const timeout_ms =
    typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
      ? Math.min(input.timeout_ms, 600_000)
      : DEFAULT_TIMEOUT;

  return { host, user, password, privateKey, port, command, timeout_ms };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`\`${field}\` is required and must be a non-empty string`);
  }
  return value;
}

function runRemoteCommand(args: Args): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const connectConfig: ConnectConfig = {
      host: args.host,
      username: args.user,
      readyTimeout: args.timeout_ms,
    };
    if (args.port) connectConfig.port = args.port;
    if (args.password) connectConfig.password = args.password;
    if (args.privateKey) connectConfig.privateKey = args.privateKey;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        // best-effort
      }
      resolve(
        formatTimedOut(args.command, args.timeout_ms!),
      );
    }, args.timeout_ms);

    const finish = (result: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        // best-effort
      }
      resolve(result);
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        // best-effort
      }
      reject(new Error(message));
    };

    conn.on("error", (err: Error & { code?: string; level?: string }) => {
      // connection-level / handshake errors land here.
      fail(formatSshError(err, args));
    });

    conn.on("ready", () => {
      conn.exec(args.command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          fail(`ssh_exec exec error: ${err.message}`);
          return;
        }
        let stdout = "";
        let stderr = "";

        stream.on("data", (chunk: Buffer) => {
          if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
        });

        stream.on("close", (code: number | null, signal: string | null) => {
          finish(
            formatResult(args.command, code, signal, stdout, stderr),
          );
        });
      });
    });

    // Suppress the default host-key verification prompt: ssh2 does not
    // prompt (no TTY) and will emit an "error" with code 'UNKNOWN_HOST' if
    // verification fails. We accept the key on first connect to keep the
    // tool non-interactive.
    try {
      conn.connect(connectConfig);
    } catch (err) {
      fail(`ssh_exec connect failed: ${(err as Error).message}`);
    }
  });
}

function formatResult(
  command: string,
  code: number | null,
  signal: string | null,
  stdout: string,
  stderr: string,
): string {
  const parts: string[] = [];
  parts.push(`command: ${command}`);
  if (signal) parts.push(`(terminated by signal ${signal})`);
  parts.push(`exit code: ${code ?? "null"}`);
  if (stdout) parts.push(`--- stdout ---\n${truncate(stdout)}`);
  if (stderr) parts.push(`--- stderr ---\n${truncate(stderr)}`);
  return parts.join("\n");
}

function formatTimedOut(command: string, timeout: number): string {
  return [
    `command: ${command}`,
    `(killed after ${timeout}ms timeout)`,
    "exit code: null",
    "--- stdout ---\n(no output captured before timeout)",
  ].join("\n");
}

function formatSshError(
  err: Error & { code?: string; level?: string },
  args: Args,
): string {
  const where = err.level ? ` (${err.level})` : "";
  let hint = "";
  if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
    hint = ` — could not reach ${args.host}${args.port ? `:${args.port}` : ""} (network/firewall/host down?)`;
  } else if (err.message.toLowerCase().includes("authentication")) {
    hint = " — authentication failed (wrong user/password/key?)";
  } else if (err.message.toLowerCase().includes("host key")) {
    hint = " — host key verification failed";
  }
  return `ssh_exec error${where}: ${err.message}${hint}`;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n... [truncated ${s.length - MAX_OUTPUT} bytes]`;
}
