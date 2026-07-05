import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

type AudioFormat = "mp3" | "flac" | "wav";

interface MusicGenerateArgs {
  prompt: string;
  lyrics: string;
  duration: number;
  outputPath?: string;
  responseFormat: AudioFormat;
  negativePrompt?: string | null;
  languageCode?: string;
}

interface DeepInfraMusicResponse {
  audio?: string;
  output_format?: string;
  duration_seconds?: number;
  seed?: number;
  generated_lyrics?: string;
  request_id?: string;
  inference_status?: {
    status?: string;
    runtime_ms?: number;
    cost?: number;
  };
  error?: {
    message?: string;
  };
}

const DEFAULT_BASE_URL = "https://api.deepinfra.com";
const DEFAULT_MODEL = "ACE-Step/acestep-v15-xl-sft";
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const MIN_DURATION_SECONDS = 30;
const MAX_DURATION_SECONDS = 180;
const DEFAULT_LANGUAGE_CODE = "id";

export const musicGenerateTool: Tool = {
  name: "music_generate",
  description:
    "Generate a music track from a text prompt and lyrics using the configured DeepInfra ACE-Step music model, then save the audio file inside the project workdir. " +
    "Use this when the user asks to create a song, jingle, background music, or music with vocals. " +
    "Provide `prompt` (genre, mood, instruments, vocals, tempo/key), `lyrics`, and `duration` in seconds. " +
    "Duration MUST be between 30 and 180 seconds. Match duration to the lyrics: short lyrics should use 30 seconds; longer lyrics can use up to 180 seconds, but do not generate songs longer than 3 minutes. " +
    "If the user asks for instrumental music, describe it clearly in `prompt` and pass an empty lyrics string. " +
    "The tool writes the result to `outputPath` if provided, otherwise it creates a timestamped file. Requires SIBERFLOW_MUSIC_API_KEY.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Music description: genre, mood, instrumentation, vocals, tempo, key, and what the song is about. Max 2000 chars.",
      },
      lyrics: {
        type: "string",
        description:
          "Lyrics to sing, with optional [verse]/[chorus] tags. Use an empty string for instrumental or model-written lyrics. Keep lyrics short enough for <= 180 seconds.",
      },
      duration: {
        type: "integer",
        minimum: MIN_DURATION_SECONDS,
        maximum: MAX_DURATION_SECONDS,
        description:
          "Track length in seconds. Minimum 30, maximum 180. Prefer 30 for short lyrics; choose longer only when the lyrics need it.",
      },
      outputPath: {
        type: "string",
        description:
          "Optional output audio path inside the project workdir. Extension should match responseFormat, e.g. song.mp3.",
      },
      responseFormat: {
        type: "string",
        enum: ["mp3", "flac", "wav"],
        description: "Output audio format. Default mp3.",
      },
      negativePrompt: {
        type: ["string", "null"],
        description: "Styles, moods, instruments, or artifacts to avoid. Optional.",
      },
      languageCode: {
        type: "string",
        description:
          "Optional language code for generated lyrics, e.g. id or en. Defaults to id.",
      },
    },
    required: ["prompt", "lyrics", "duration"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = parseArgs(rawArgs);
    const apiKey = process.env.SIBERFLOW_MUSIC_API_KEY;
    if (!apiKey) {
      return "Error: SIBERFLOW_MUSIC_API_KEY is not set.";
    }

    const model = (process.env.SIBERFLOW_MUSIC_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const baseUrl = (process.env.SIBERFLOW_MUSIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const outputPath = await resolveOutputPath(ctx, args);
    const payload = buildPayload(args);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/inference/${model}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = controller.signal.aborted
        ? `music generation timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : (err as Error).message;
      return `Error: ${reason}`;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errorText = await readErrorText(res);
      return `Error: music provider returned HTTP ${res.status}: ${errorText}`;
    }

    const contentType = res.headers.get("content-type") ?? "";
    let meta: DeepInfraMusicResponse = {};
    let audio: Buffer;
    if (/^audio\//i.test(contentType)) {
      audio = Buffer.from(await res.arrayBuffer());
    } else {
      const json = (await res.json().catch(() => ({}))) as DeepInfraMusicResponse;
      meta = json;
      if (!json.audio) {
        return `Error: music provider returned no audio field.${json.error?.message ? ` ${json.error.message}` : ""}`;
      }
      audio = decodeAudio(json.audio);
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, audio);

    return summarizeResult(outputPath, audio.byteLength, args, meta);
  },
};

function parseArgs(raw: unknown): MusicGenerateArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Arguments must be an object.");
  }
  const args = raw as Record<string, unknown>;

  if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
    throw new Error("`prompt` is required and must be a non-empty string.");
  }
  const prompt = args.prompt.trim();
  if (prompt.length > 2000) {
    throw new Error("`prompt` must be 2000 characters or less.");
  }

  if (typeof args.lyrics !== "string") {
    throw new Error("`lyrics` is required and must be a string. Use an empty string for instrumental music.");
  }
  const lyrics = args.lyrics.trim();
  if (lyrics.length > 8000) {
    throw new Error("`lyrics` must be 8000 characters or less.");
  }

  const duration = parseInteger(args.duration, "`duration`");
  if (duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    throw new Error("`duration` must be between 30 and 180 seconds.");
  }

  const responseFormat = parseFormat(args.responseFormat);
  const out: MusicGenerateArgs = {
    prompt,
    lyrics,
    duration,
    responseFormat,
    languageCode: DEFAULT_LANGUAGE_CODE,
  };

  if (typeof args.outputPath === "string" && args.outputPath.trim()) {
    out.outputPath = args.outputPath.trim();
  }
  if (typeof args.negativePrompt === "string") {
    const negativePrompt = args.negativePrompt.trim();
    out.negativePrompt = negativePrompt.length > 0 ? negativePrompt : null;
  } else if (args.negativePrompt === null) {
    out.negativePrompt = null;
  }
  if (typeof args.languageCode === "string" && args.languageCode.trim()) {
    out.languageCode = args.languageCode.trim();
  }

  return out;
}

function parseInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return value;
}

function parseFormat(value: unknown): AudioFormat {
  if (value === undefined || value === null || value === "") return "mp3";
  if (value === "mp3" || value === "flac" || value === "wav") return value;
  throw new Error("`responseFormat` must be mp3, flac, or wav.");
}

function buildPayload(args: MusicGenerateArgs): Record<string, unknown> {
  return {
    prompt: args.prompt,
    lyrics: args.lyrics,
    response_format: args.responseFormat,
    duration: args.duration,
    negative_prompt: args.negativePrompt ?? null,
    ...(args.languageCode ? { language_code: args.languageCode } : {}),
  };
}

async function resolveOutputPath(ctx: ToolContext, args: MusicGenerateArgs): Promise<string> {
  const requested = args.outputPath?.trim() || defaultOutputName(args);
  const withExt = ensureExtension(requested, args.responseFormat);
  return resolveWithin(ctx.projectDir, withExt);
}

function defaultOutputName(args: MusicGenerateArgs): string {
  const stem = slugify(args.prompt).slice(0, 48) || "music";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `generated-music/${stamp}-${stem}.${args.responseFormat}`;
}

function ensureExtension(path: string, format: AudioFormat): string {
  const ext = extname(path).toLowerCase();
  if (ext === `.${format}`) return path;
  if (ext === "") return `${path}.${format}`;
  return `${path.slice(0, -ext.length)}.${format}`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeAudio(audio: string): Buffer {
  const comma = audio.indexOf(",");
  const maybeBase64 = audio.startsWith("data:") && comma !== -1 ? audio.slice(comma + 1) : audio;
  return Buffer.from(maybeBase64, "base64");
}

async function readErrorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text.trim()) return res.statusText;
  try {
    const json = JSON.parse(text) as DeepInfraMusicResponse;
    return json.error?.message ?? text.slice(0, 1000);
  } catch {
    return text.slice(0, 1000);
  }
}

function summarizeResult(
  outputPath: string,
  bytes: number,
  args: MusicGenerateArgs,
  meta: DeepInfraMusicResponse,
): string {
  const lines = [
    "Music generated successfully.",
    `Path: ${outputPath}`,
    `File: ${basename(outputPath)}`,
    `Bytes: ${bytes}`,
    `Format: ${meta.output_format ?? args.responseFormat}`,
    `Requested duration: ${args.duration}s`,
  ];
  if (meta.duration_seconds !== undefined) lines.push(`Generated duration: ${meta.duration_seconds}s`);
  if (meta.seed !== undefined) lines.push(`Seed: ${meta.seed}`);
  if (meta.request_id) lines.push(`Request ID: ${meta.request_id}`);
  if (meta.inference_status?.status) lines.push(`Status: ${meta.inference_status.status}`);
  if (meta.inference_status?.runtime_ms !== undefined) {
    lines.push(`Runtime: ${meta.inference_status.runtime_ms}ms`);
  }
  if (meta.inference_status?.cost !== undefined) lines.push(`Cost USD: ${meta.inference_status.cost}`);
  if (meta.generated_lyrics) {
    lines.push(`Generated lyrics:\n${meta.generated_lyrics}`);
  }
  return lines.join("\n");
}
