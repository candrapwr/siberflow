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
 * - SIBERFLOW_IMAGE_GEN_PROVIDER  sibergate | openai | general | deepinfra | novita | qwen | grok
 * - SIBERFLOW_IMAGE_GEN_MODEL     model id (default per provider; for the
 *                                 `sibergate` provider this is a ROUTE ID)
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
  aspect_ratio: string;
  resolution?: string;
  negative_prompt?: string;
}

const VALID_ASPECT_RATIOS = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
] as const;

const DEFAULT_ASPECT_RATIO = "16:9";
const VALID_RESOLUTIONS = ["1k", "2k"] as const;

export const imageGenTool: Tool = {
  name: "image_gen",
  description:
    "Generate a new image from a text prompt, or edit an existing image file\n\n" +
    "- `prompt` (required): describe the desired image in detail.\n" +
    "- `image` (optional): path to a local image file in the workdir for edit " +
    "mode. Omit to generate a brand-new image.\n" +
    "- `outputPath` (optional): output path inside the workdir. Defaults to " +
    "generated-images/<timestamp>-<slug>.png.\n" +
    "- `aspect_ratio` (optional): 16:9 (default), 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, or 21:9. " +
    "Provider support varies.\n" +
    "- `resolution` (optional): 1k or 2k. Omit unless the user asks for high quality; use 2k when they do. " +
    "When omitted, the provider default is 1k.\n" +
    "- `negative_prompt` (optional): things to avoid in the image (e.g. 'blur, text, " +
    "extra fingers'). Supported providers only; ignored otherwise.\n\n",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Detailed description of the image to generate, or the edit instruction when modifying.",
      },
      image: {
        type: "string",
        description:
          "Path to a source image in the workdir (edit mode). Omit to generate a new image.",
      },
      outputPath: {
        type: "string",
        description:
          "Optional output path inside the project workdir (e.g. my-image.png). " +
          "Defaults to generated-images/<timestamp>-<slug>.png.",
      },
      aspect_ratio: {
        type: "string",
        enum: VALID_ASPECT_RATIOS,
        description: "Image aspect ratio. Default 16:9.",
      },
      resolution: {
        type: "string",
        enum: VALID_RESOLUTIONS,
        description:
          "Image resolution. Omit unless the user asks for high quality; use 2k when they do. Default 1k when omitted.",
      },
      negative_prompt: {
        type: "string",
        description:
          "Things to AVOID in the image (e.g. 'blur, text, extra fingers'). " +
          "Forwarded to providers that support it; ignored otherwise.",
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
      aspect_ratio: args.aspect_ratio,
      ...(args.resolution ? { resolution: args.resolution } : {}),
      ...(args.negative_prompt ? { negativePrompt: args.negative_prompt } : {}),
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
  const out: ImageGenArgs = {
    prompt: args.prompt.trim(),
    aspect_ratio: DEFAULT_ASPECT_RATIO,
  };
  if (typeof args.image === "string" && args.image.trim()) {
    out.image = args.image.trim();
  }
  if (typeof args.outputPath === "string" && args.outputPath.trim()) {
    out.outputPath = args.outputPath.trim();
  }
  if (
    typeof args.aspect_ratio === "string" &&
    (VALID_ASPECT_RATIOS as readonly string[]).includes(args.aspect_ratio)
  ) {
    out.aspect_ratio = args.aspect_ratio;
  }
  if (
    typeof args.resolution === "string" &&
    (VALID_RESOLUTIONS as readonly string[]).includes(args.resolution)
  ) {
    out.resolution = args.resolution;
  }
  if (typeof args.negative_prompt === "string" && args.negative_prompt.trim()) {
    out.negative_prompt = args.negative_prompt.trim();
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
