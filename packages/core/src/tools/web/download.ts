import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const TIMEOUT_MS = 300_000; // 5 minutes

interface Args {
  url: string;
  save_path: string;
}

export const downloadFileTool: Tool = {
  name: "download_file",
  description:
    "Download a file from http(s) URL to the project directory. " +
    "Max 100 MB. Returns error as result on any failure.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The URL to download from (http or https).",
      },
      save_path: {
        type: "string",
        description:
          "Relative or absolute path inside the project directory, including the filename. " +
          "Parent directories are created automatically. " +
          "Example: 'downloads/file.zip' or 'images/photo.jpg'.",
      },
    },
    required: ["url", "save_path"],
    additionalProperties: false,
  },
  async execute(rawArgs, ctx) {
    try {
      const { url, save_path } = rawArgs as Args;

      if (!url || typeof url !== "string") {
        return "Error: `url` is required and must be a non-empty string.";
      }
      if (!save_path || typeof save_path !== "string") {
        return "Error: `save_path` is required and must be a non-empty string.";
      }

      const trimmedUrl = url.trim();
      if (!/^https?:\/\//i.test(trimmedUrl)) {
        return "Error: `url` must start with http:// or https://.";
      }

      // Resolve save path inside the project sandbox
      const fullPath = await resolveWithin(ctx.projectDir, save_path.trim());
      await mkdir(dirname(fullPath), { recursive: true });

      // Step 1: Check file size via HEAD request (best-effort)
      const sizeCheck = await checkSize(trimmedUrl);
      if (typeof sizeCheck === "string") return sizeCheck;

      // Step 2: Download with streaming + size enforcement
      return await doDownload(trimmedUrl, fullPath);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

/**
 * Attempt a HEAD request to check Content-Length before downloading.
 * Returns `true` if the file is within limits or HEAD is unavailable.
 * Returns an error string if the file clearly exceeds the 100 MB limit.
 */
async function checkSize(url: string): Promise<true | string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return true; // HEAD not supported — proceed to download

    const raw = res.headers.get("content-length");
    if (!raw) return true; // no length info — proceed

    const bytes = Number.parseInt(raw, 10);
    if (!Number.isFinite(bytes)) return true;

    if (bytes > MAX_BYTES) {
      return `Error: Remote file is ${(bytes / 1024 / 1024).toFixed(1)} MB, which exceeds the 100 MB limit.`;
    }
    return true;
  } catch {
    // HEAD failed (network error, timeout) — proceed; the stream will enforce the limit
    return true;
  }
}

/**
 * Download the file with streaming. Enforces the 100 MB limit mid-stream
 * and cleans up the partial file on any error. Errors are returned as
 * strings so the model sees them in the tool result.
 */
async function doDownload(url: string, dest: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const msg =
      (err as Error).name === "AbortError"
        ? "Request timed out after 5 minutes."
        : (err as Error).message;
    return `Error: ${msg}`;
  }
  clearTimeout(timer);

  if (!response.ok) {
    return `Error: HTTP ${response.status} ${response.statusText}`;
  }

  // Re-check Content-Length from GET response (may differ from HEAD)
  const raw = response.headers.get("content-length");
  if (raw) {
    const bytes = Number.parseInt(raw, 10);
    if (Number.isFinite(bytes) && bytes > MAX_BYTES) {
      return `Error: Remote file is ${(bytes / 1024 / 1024).toFixed(1)} MB, which exceeds the 100 MB limit.`;
    }
  }

  const body = response.body;
  if (!body) {
    return "Error: Response has no readable body stream.";
  }

  const reader = body.getReader();
  const fileStream = createWriteStream(dest);
  let downloaded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      downloaded += value.byteLength;
      if (downloaded > MAX_BYTES) {
        fileStream.close();
        reader.cancel().catch(() => {});
        await unlink(dest).catch(() => {});
        return `Error: Download exceeded 100 MB limit (${(downloaded / 1024 / 1024).toFixed(1)} MB received so far).`;
      }

      const canContinue = fileStream.write(Buffer.from(value));
      if (!canContinue) {
        await new Promise<void>((resolve) => fileStream.once("drain", resolve));
      }
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err) => (err ? reject(err) : resolve()));
    });

    return `Downloaded ${url} → ${dest} (${(downloaded / 1024 / 1024).toFixed(2)} MB)`;
  } catch (err) {
    fileStream.destroy();
    reader.cancel().catch(() => {});
    // Clean up partial file
    await unlink(dest).catch(() => {});
    return `Error: Download failed: ${(err as Error).message}`;
  }
}
