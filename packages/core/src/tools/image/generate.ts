/**
 * `image_gen` tool — generate or edit images via an external image API.
 *
 * Mirrors the structure of `music_generate`: reads config from env, calls an
 * external provider, and writes the result image into the session workdir. The
 * tool supports generation (prompt only) and editing (prompt + a source image
 * path). Disabled by default — enable by adding `image_gen` to
 * SIBERFLOW_TOOLS / SIBERFLOW_TELEGRAM_TOOLS.
 *
 * Config (env, prefix SIBERFLOW_IMAGE_GEN_):
 * - SIBERFLOW_IMAGE_GEN_API_KEY  (required at call time)
 * - SIBERFLOW_IMAGE_GEN_PROVIDER  openai | deepinfra | novita | qwen | grok
 * - SIBERFLOW_IMAGE_GEN_MODEL     model id (default per provider)
 * - SIBERFLOW_IMAGE_GEN_BASE_URL  API root (default per provider)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";
import {
  IMAGE_GEN_PROVIDERS,
  PROVIDER_DEFAULTS,
  type ImageGenRequest,
} from "./providers.js";

interface ImageGenArgs {
  prompt: string;
  image?: string;
  outputPath?: string;
  size?: string;
}

const VALID_SIZES = ["1024x1024", "1792x1024", "1024x1792"] as const;

export const imageGenTool: Tool = {
  name: "image_gen",
  description:
    "Generate a new image from a text prompt, or edit an existing image file\n\n" +
    "- `prompt` (required): describe the desired image in detail.\n" +
    "- `image` (optional): path to a local image file in the workdir for edit " +
    "mode. Omit to generate a brand-new image.\n" +
    "- `outputPath` (optional): output path inside the workdir. Defaults to " +
    "generated-images/<timestamp>-<slug>.png.\n" +
    "- `size` (optional): 1024x1024 (default), 1792x1024, or 1024x1792. " +
    "Provider support varies.\n\n",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Detailed description of the image to generate, or the edit instruction " +
          "when modifying an existing image. Be specific about style, composition, " +
          "colors, lighting, and subject.",
      },
      image: {
        type: "string",
        description:
          "Path to a source image file inside the project workdir. When provided, " +
          "the tool runs in EDIT mode (modify the image per `prompt`). When omitted, " +
          "the tool generates a new image from scratch.",
      },
      outputPath: {
        type: "string",
        description:
          "Optional output path inside the project workdir (e.g. my-image.png). " +
          "Defaults to generated-images/<timestamp>-<slug>.png.",
      },
      size: {
        type: "string",
        enum: VALID_SIZES,
        description: "Image dimensions. Default 1024x1024.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = parseArgs(rawArgs);

    // ── Resolve provider config from env ──
    // Base: image-gen config (SIBERFLOW_IMAGE_GEN_*).
    let providerName = (process.env.SIBERFLOW_IMAGE_GEN_PROVIDER ?? "openai").trim() || "openai";
    let apiKey = process.env.SIBERFLOW_IMAGE_GEN_API_KEY;
    let defaults = PROVIDER_DEFAULTS[providerName] ?? PROVIDER_DEFAULTS.openai!;
    let baseUrl =
      (process.env.SIBERFLOW_IMAGE_GEN_BASE_URL ?? defaults.baseUrl).trim() || defaults.baseUrl;
    let model = (process.env.SIBERFLOW_IMAGE_GEN_MODEL ?? defaults.model).trim() || defaults.model;

    // ── Edit-mode override (SIBERFLOW_IMAGE_EDIT_*) with per-field fallback ──
    // When editing (args.image present), each EDIT field overrides the GEN
    // field ONLY when non-empty. Empty/absent EDIT fields fall back to the GEN
    // value above, so a user can set just a different key (everything else
    // inherited) OR a fully different provider.
    if (args.image) {
      const editProvider = (process.env.SIBERFLOW_IMAGE_EDIT_PROVIDER ?? "").trim();
      const editApiKey = (process.env.SIBERFLOW_IMAGE_EDIT_API_KEY ?? "").trim();
      const editModel = (process.env.SIBERFLOW_IMAGE_EDIT_MODEL ?? "").trim();
      const editBaseUrl = (process.env.SIBERFLOW_IMAGE_EDIT_BASE_URL ?? "").trim();
      if (editProvider) {
        providerName = editProvider;
        // Re-resolve defaults for the (possibly different) edit provider.
        defaults = PROVIDER_DEFAULTS[providerName] ?? PROVIDER_DEFAULTS.openai!;
      }
      if (editApiKey) apiKey = editApiKey;
      if (editModel) model = editModel.trim() || defaults.model;
      if (editBaseUrl) baseUrl = editBaseUrl.trim().replace(/\/+$/, "") || defaults.baseUrl;
      else if (editProvider) baseUrl = defaults.baseUrl; // provider changed → use its default base
    }

    const provider = IMAGE_GEN_PROVIDERS[providerName];
    const mode: "generate" | "edit" = args.image ? "edit" : "generate";
    if (!provider) {
      ctx.imageAccessLogger?.({
        userId: ctx.userId ?? "unknown",
        tool: "image_gen",
        mode,
        model,
        status: "error",
        error: `Unknown provider "${providerName}"`,
      });
      return `Error: Unknown image provider "${providerName}". Supported: ${Object.keys(IMAGE_GEN_PROVIDERS).join(", ")}.`;
    }
    if (!apiKey) {
      ctx.imageAccessLogger?.({
        userId: ctx.userId ?? "unknown",
        tool: "image_gen",
        mode,
        model,
        status: "error",
        error: "API key not set",
      });
      return "Error: SIBERFLOW_IMAGE_GEN_API_KEY is not set.";
    }

    const baseReq: ImageGenRequest = {
      prompt: args.prompt,
      apiKey,
      model,
      baseUrl,
      ...(args.size ? { size: args.size } : {}),
    };

    // ── Run generation or edit ──
    let result;
    try {
      if (args.image) {
        if (!provider.edit) {
          ctx.imageAccessLogger?.({
            userId: ctx.userId ?? "unknown",
            tool: "image_gen",
            mode,
            model,
            status: "error",
            error: `Provider "${providerName}" does not support editing`,
          });
          return `Error: Provider "${providerName}" does not support image editing. Use one without the \`image\` param, or switch provider.`;
        }
        // Resolve the source image path inside the workdir sandbox.
        const resolvedImage = await resolveWithin(ctx.projectDir, args.image);
        result = await provider.edit({ ...baseReq, imagePath: resolvedImage });
      } else {
        result = await provider.generate(baseReq);
      }
    } catch (err) {
      ctx.imageAccessLogger?.({
        userId: ctx.userId ?? "unknown",
        tool: "image_gen",
        mode,
        model,
        status: "error",
        error: (err as Error).message,
      });
      return `Error: ${mode} failed: ${(err as Error).message}`;
    }

    // ── Resolve output path & write file ──
    const outputPath = await resolveOutputPath(ctx, args, result.format);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.buffer);

    ctx.imageAccessLogger?.({
      userId: ctx.userId ?? "unknown",
      tool: "image_gen",
      mode,
      model,
      status: "success",
    });
    return summarizeResult(outputPath, result.buffer.byteLength, mode, providerName, model);
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function parseArgs(raw: unknown): ImageGenArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Arguments must be an object.");
  }
  const args = raw as Record<string, unknown>;
  if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
    throw new Error("`prompt` is required and must be a non-empty string.");
  }
  const out: ImageGenArgs = { prompt: args.prompt.trim() };
  if (typeof args.image === "string" && args.image.trim()) {
    out.image = args.image.trim();
  }
  if (typeof args.outputPath === "string" && args.outputPath.trim()) {
    out.outputPath = args.outputPath.trim();
  }
  if (typeof args.size === "string" && (VALID_SIZES as readonly string[]).includes(args.size)) {
    out.size = args.size;
  }
  return out;
}

async function resolveOutputPath(
  ctx: ToolContext,
  args: ImageGenArgs,
  format: string,
): Promise<string> {
  const requested = args.outputPath?.trim() || defaultOutputName(args, format);
  const withExt = ensureExtension(requested, format);
  return resolveWithin(ctx.projectDir, withExt);
}

function defaultOutputName(args: ImageGenArgs, format: string): string {
  const stem = slugify(args.prompt).slice(0, 48) || "image";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `generated-images/${stamp}-${stem}.${format}`;
}

function ensureExtension(path: string, format: string): string {
  const ext = extname(path).toLowerCase().replace(".", "");
  if (ext === format) return path;
  if (ext === "") return `${path}.${format}`;
  return `${path.slice(0, path.length - ext.length)}${format}`;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function summarizeResult(
  outputPath: string,
  bytes: number,
  mode: string,
  providerName: string,
  model: string,
): string {
  return [
    `Image ${mode === "edit" ? "edit" : "generation"} completed.`,
    `Path: ${outputPath}`,
    `File: ${basename(outputPath)}`,
    `Bytes: ${bytes}`,
    `Mode: ${mode}`,
    `Provider: ${providerName}`,
    `Model: ${model}`,
  ].join("\n");
}
