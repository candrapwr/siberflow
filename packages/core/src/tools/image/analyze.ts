import { readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { Tool, ToolContext } from "../base.js";
import { resolveWithin } from "../file/path-utils.js";

interface AnalyzeImageArgs {
  image: string;
  prompt: string;
  detail?: "low" | "high" | "auto";
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * Hard cap on a single multimodal request. Without this, a slow or stuck
 * provider can hang the tool (and therefore the whole agent turn) until the OS
 * TCP timeout, which can be minutes. On timeout we return a tool-result error
 * string (the project convention for tool failures) so the model can react,
 * rather than throwing and aborting the turn.
 */
const REQUEST_TIMEOUT_MS = 60_000;

export const analyzeImageTool: Tool = {
  name: "analyze_image",
  description:
    "Analyze an image with a configured multimodal OpenAI-compatible model. " +
    "Input can be a local image path inside the project/upload sandbox, an http(s) image URL, or a data:image URL. " +
    "Use this when the user asks what is in an image, wants OCR, visual description, chart/table extraction, or image-based reasoning.",
  parameters: {
    type: "object",
    properties: {
      image: {
        type: "string",
        description:
          "Image path, http(s) URL, or data:image URL. Local paths must be inside the project directory or upload sandbox.",
      },
      prompt: {
        type: "string",
        description:
          "Question or instruction for the multimodal model, e.g. 'Describe this image' or 'Extract the text from this screenshot'.",
      },
      detail: {
        type: "string",
        enum: ["low", "high", "auto"],
        description: "Image detail level passed to OpenAI-compatible vision content. Default: auto.",
      },
    },
    required: ["image", "prompt"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const args = parseArgs(rawArgs);
    const apiKey = process.env.SIBERFLOW_MULTIMODAL_API_KEY;
    if (!apiKey) {
      return "Error: SIBERFLOW_MULTIMODAL_API_KEY is not set.";
    }
    const model = process.env.SIBERFLOW_MULTIMODAL_MODEL;
    if (!model) {
      return "Error: SIBERFLOW_MULTIMODAL_MODEL is not set.";
    }

    const imageUrl = await resolveImageUrl(args.image, ctx);
    const baseUrl = (process.env.SIBERFLOW_MULTIMODAL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    // AbortController gives the fetch a hard timeout. Without it, a hung
    // multimodal provider would block the turn indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: args.prompt },
                {
                  type: "image_url",
                  image_url: {
                    url: imageUrl,
                    detail: args.detail ?? "auto",
                  },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Return a tool-result error string (project convention) so the model
      // can recover, instead of throwing and aborting the whole turn. Covers
      // both our timeout abort and genuine network failures.
      const aborted = controller.signal.aborted;
      const reason =
        aborted
          ? `image analysis timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : (err as Error).message;
      return `Error: ${reason}`;
    } finally {
      clearTimeout(timer);
    }

    const json = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
    if (!res.ok) {
      return `Error: multimodal provider returned HTTP ${res.status}: ${json.error?.message ?? res.statusText}`;
    }

    const content = json.choices?.[0]?.message?.content?.trim();
    return content || "Error: multimodal provider returned no text content.";
  },
};

function parseArgs(raw: unknown): AnalyzeImageArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Arguments must be an object.");
  }
  const args = raw as Record<string, unknown>;
  if (typeof args.image !== "string" || args.image.trim().length === 0) {
    throw new Error("image must be a non-empty string.");
  }
  if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string.");
  }
  const out: AnalyzeImageArgs = {
    image: args.image.trim(),
    prompt: args.prompt.trim(),
  };
  if (args.detail === "low" || args.detail === "high" || args.detail === "auto") {
    out.detail = args.detail;
  }
  return out;
}

async function resolveImageUrl(image: string, ctx: ToolContext): Promise<string> {
  if (image.startsWith("data:image/")) return image;
  if (/^https?:\/\//i.test(image)) return image;

  const abs = await resolveImagePath(image, ctx);
  const data = await readFile(abs);
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is too large (${data.byteLength} bytes). Maximum supported size is ${MAX_IMAGE_BYTES} bytes.`,
    );
  }
  const mime = mimeFor(abs);
  return `data:${mime};base64,${data.toString("base64")}`;
}

async function resolveImagePath(image: string, ctx: ToolContext): Promise<string> {
  try {
    return await resolveWithin(ctx.projectDir, image);
  } catch (projectErr) {
    if (!ctx.uploadDir) throw projectErr;
    const candidate = isAbsolute(image) ? image : resolve(ctx.uploadDir, basename(image));
    const targetReal = await realpath(candidate);
    const uploadReal = await realpath(ctx.uploadDir);
    const rel = relative(uploadReal, targetReal);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return targetReal;
    }
    throw projectErr;
  }
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}
