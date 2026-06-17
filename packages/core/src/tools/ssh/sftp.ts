import { createReadStream, createWriteStream } from "node:fs";
import { mkdir as fsMkdir, stat as fsStat } from "node:fs/promises";
import { dirname } from "node:path";
import { Client, type ConnectConfig, type SFTPWrapper, type Stats } from "ssh2";
import type { Tool } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

type Mode = "upload" | "download";

interface BaseArgs {
  mode: Mode;
  host: string;
  user: string;
  password?: string;
  privateKey?: string;
  port?: number;
  /** Local path, absolute or relative to the project directory (sandboxed). */
  localPath: string;
  /** Absolute path on the remote host. */
  remotePath: string;
}

const DEFAULT_TIMEOUT = 60_000;
/** Files larger than this report a warning but still transfer. */
const LARGE_FILE_WARN = 10 * 1024 * 1024; // 10 MB

/**
 * sftp — transfer a single file to/from a remote host over SFTP.
 *
 *   upload   → localPath (project sandbox) → remotePath (absolute remote)
 *   download → remotePath (absolute remote) → localPath (project sandbox)
 *
 * Uses the same auth/connection pattern as ssh_exec (password OR privateKey).
 * Local path is sandboxed to the project directory (like read_file/write_file);
 * remote path is unrestricted (runs as the remote user). Directories on the
 * destination side are created as needed (mkdir -p equivalent).
 */
export const sftpTool: Tool = {
  name: "sftp",
  description:
    "Transfer a single file between the local project and a remote host over SFTP. " +
      "mode=upload sends localPath (sandboxed to project dir) to remotePath (absolute remote path); " +
      "mode=download fetches remotePath into localPath (sandboxed). " +
      "Provide host + user + (password OR privateKey). " +
      "Creates destination directories as needed (mkdir -p). " +
      "There is NO sandbox on the remote side — the transfer runs as the given remote user.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["upload", "download"],
        description: "Direction of transfer: upload = local→remote, download = remote→local",
      },
      host: { type: "string", description: "Remote host (hostname or IP, without user@)" },
      user: { type: "string", description: "SSH login user on the remote host" },
      password: { type: "string", description: "SSH password (alternative to privateKey)" },
      privateKey: { type: "string", description: "PEM-format private key string (alternative to password)" },
      port: { type: "integer", description: "SSH port (default 22)", minimum: 1, maximum: 65535 },
      localPath: {
        type: "string",
        description: "Local file path, absolute or relative to the project dir (sandboxed)",
      },
      remotePath: {
        type: "string",
        description: "Absolute path on the remote host",
      },
    },
    required: ["mode", "host", "user", "localPath", "remotePath"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = validateArgs(args);
    const localAbs = await resolveWithin(ctx.projectDir, parsed.localPath);
    return await transfer(parsed, localAbs);
  },
};

function validateArgs(args: unknown): BaseArgs {
  if (!args || typeof args !== "object") {
    throw new Error("arguments must be an object");
  }
  const input = args as Record<string, unknown>;

  const mode = input.mode;
  if (mode !== "upload" && mode !== "download") {
    throw new Error('`mode` must be "upload" or "download"');
  }
  const host = requireString(input.host, "host");
  const user = requireString(input.user, "user");
  const localPath = requireString(input.localPath, "localPath");
  const remotePath = requireString(input.remotePath, "remotePath");
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
    typeof input.port === "number" && Number.isFinite(input.port) ? input.port : undefined;

  return { mode, host, user, password, privateKey, port, localPath, remotePath };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`\`${field}\` is required and must be a non-empty string`);
  }
  return value;
}

function transfer(args: BaseArgs, localAbs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

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

    const timer = setTimeout(() => {
      fail(`sftp timed out after ${DEFAULT_TIMEOUT}ms`);
    }, DEFAULT_TIMEOUT);

    conn.on("error", (err: Error & { level?: string; code?: string }) => {
      const where = err.level ? ` (${err.level})` : "";
      let hint = "";
      const msg = err.message.toLowerCase();
      if (err.code === "ECONNREFUSED") {
        hint = " — could not reach host (network/firewall?)";
      } else if (msg.includes("authentication")) {
        hint = " — authentication failed (wrong user/password/key?)";
      }
      fail(`sftp error${where}: ${err.message}${hint}`);
    });

    conn.on("ready", () => {
      conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          fail(`sftp session error: ${err.message}`);
          return;
        }
        const run = args.mode === "upload" ? doUpload : doDownload;
        run(sftp, conn, args, localAbs).then(finish).catch(fail);
      });
    });

    const connectConfig: ConnectConfig = {
      host: args.host,
      username: args.user,
      readyTimeout: DEFAULT_TIMEOUT,
    };
    if (args.port) connectConfig.port = args.port;
    if (args.password) connectConfig.password = args.password;
    if (args.privateKey) connectConfig.privateKey = args.privateKey;
    conn.connect(connectConfig);
  });
}

async function doUpload(
  sftp: SFTPWrapper,
  _conn: Client,
  args: BaseArgs,
  localAbs: string,
): Promise<string> {
  const localStat = await fsStat(localAbs);
  if (!localStat.isFile()) {
    throw new Error(`localPath is not a regular file: ${localAbs}`);
  }

  // Ensure the remote destination directory exists (mkdir -p).
  await ensureRemoteDir(sftp, args.remotePath);

  return await new Promise<string>((resolve, reject) => {
    const readStream = createReadStream(localAbs);
    const writeStream = sftp.createWriteStream(args.remotePath);
    let bytes = 0;
    readStream.on("data", (chunk: unknown) => {
      bytes += chunkSize(chunk);
    });
    writeStream.on("error", (err: Error) => reject(new Error(`upload write error: ${err.message}`)));
    readStream.on("error", (err: Error) => reject(new Error(`upload read error: ${err.message}`)));
    writeStream.on("close", () => {
      sftp.end();
      resolve(
        formatResult("upload", localAbs, args.remotePath, localStat.size, bytes),
      );
    });
    readStream.pipe(writeStream);
  });
}

async function doDownload(
  sftp: SFTPWrapper,
  _conn: Client,
  args: BaseArgs,
  localAbs: string,
): Promise<string> {
  const remoteStat = await statRemote(sftp, args.remotePath);
  // Ensure the local destination directory exists.
  await fsMkdir(dirname(localAbs), { recursive: true });

  return await new Promise<string>((resolve, reject) => {
    const readStream = sftp.createReadStream(args.remotePath);
    const writeStream = createWriteStream(localAbs);
    let bytes = 0;
    readStream.on("data", (chunk: unknown) => {
      bytes += chunkSize(chunk);
    });
    writeStream.on("error", (err: Error) => reject(new Error(`download write error: ${err.message}`)));
    readStream.on("error", (err: Error) => reject(new Error(`download read error: ${err.message}`)));
    writeStream.on("close", () => {
      sftp.end();
      resolve(
        formatResult("download", localAbs, args.remotePath, remoteStat?.size ?? 0, bytes),
      );
    });
    readStream.pipe(writeStream);
  });
}

/** stat a remote file; returns undefined if it does not exist. */
function statRemote(
  sftp: SFTPWrapper,
  remotePath: string,
): Promise<{ size: number; isFile: boolean } | undefined> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err: Error | undefined, stats: Stats) => {
      if (err) {
        resolve(undefined);
        return;
      }
      resolve({ size: stats.size, isFile: stats.isFile() });
    });
  });
}

/**
 * Recursively create the directory holding `remoteFile` on the remote host.
 * Walk from the root down, mkdir each missing segment (ignore "already exists").
 */
async function ensureRemoteDir(sftp: SFTPWrapper, remoteFile: string): Promise<void> {
  const dir = dirname(remoteFile);
  if (dir === "/" || dir === "." || dir === "") return;
  const segments = dir.split("/").filter(Boolean);
  let current = "";
  for (const seg of segments) {
    current += `/${seg}`;
    await new Promise<void>((resolve) => {
      sftp.mkdir(current, (err) => {
        // Ignore "already exists" — only fail on hard errors.
        if (err && (err as NodeJS.ErrnoException).code !== "EEXIST" && !/exist/i.test(err.message)) {
          // best-effort: continue anyway; the createWriteStream will surface a real failure
        }
        resolve();
      });
    });
  }
}

/** Get the byte length of a stream chunk (Buffer or string). */
function chunkSize(chunk: unknown): number {
  if (typeof chunk === "string") return chunk.length;
  if (chunk && typeof chunk === "object" && "length" in chunk) {
    return Number((chunk as { length: number }).length) || 0;
  }
  return 0;
}

function formatResult(
  mode: Mode,
  localPath: string,
  remotePath: string,
  expectedSize: number,
  transferred: number,
): string {
  const arrow = mode === "upload" ? "→" : "←";
  const lines = [
    `sftp ${mode} ok`,
    `${localPath} ${arrow} ${remotePath}`,
    `transferred: ${transferred.toLocaleString("en-US")} bytes`,
  ];
  if (expectedSize > 0 && transferred !== expectedSize) {
    lines.push(`warning: size mismatch (source reported ${expectedSize.toLocaleString("en-US")} bytes)`);
  }
  if (expectedSize > LARGE_FILE_WARN) {
    lines.push(`note: large file (${(expectedSize / 1024 / 1024).toFixed(1)} MB)`);
  }
  return lines.join("\n");
}
