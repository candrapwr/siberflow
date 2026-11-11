import type { ContentBlock } from "../../agent/types.js";
import type { Tool, ToolContext } from "../base.js";
import { resolveImageUrl } from "./analyze.js";

/**
 * `analyze_image_native` — the native-vision sibling of `analyze_image`.
 *
 * Unlike `analyze_image` (which calls a separate multimodal sub-model and
 * returns its text), this tool does NOT make any LLM call of its own. Instead
 * it resolves the image and hands it to the agent loop, which injects it as a
 * multimodal `user` message so the MAIN model reads the pixels with its own
 * vision. This is what "vision mode" means: the main model sees the image.
 *
 * The handoff uses `ctx.pendingVisionBlocks` (an out-of-band queue) rather than
 * embedding base64 in the tool-result string, so history/compaction never has
 * to carry the raw payload through a text field — the image lives only in the
 * dedicated user message, where contentToText() renders it as "[image]".
 *
 * Registered ONLY when vision mode is on; `analyze_image` is removed at the
 * same time (hosts swap the two via enabledTools), so the model never sees two
 * overlapping image-reading tools.
 */
export const analyzeImageNativeTool: Tool = {
  name: "analyze_image_native",
  description:
    "Read an image yourself (native vision). The image is injected into the " +
    "conversation and you will see it in the next step — you (the main model) " +
    "describe/OCR/reason about it directly, no separate vision model is used. " +
    "Input can be a local image path inside the project/upload sandbox, an " +
    "http(s) image URL, or a data:image URL. Use this whenever the user asks " +
    "what is in an image or a screenshot needs to be understood.",
  parameters: {
    type: "object",
    properties: {
      image: {
        type: "string",
        description:
          "Image path, http(s) URL, or data:image URL. Local paths must be inside the project directory or upload sandbox.",
      },
      instruction: {
        type: "string",
        description:
          "What to focus on when reading the image, e.g. 'OCR all text from the table' or 'describe the chart axes and values'. This becomes the text that accompanies the injected image.",
      },
      detail: {
        type: "string",
        enum: ["low", "high", "auto"],
        description: "Vision detail level (OpenAI-compatible). Default: auto.",
      },
    },
    required: ["image", "instruction"],
    additionalProperties: false,
  },
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return "Error: arguments must be an object.";
    }
    const args = rawArgs as Record<string, unknown>;
    if (typeof args.image !== "string" || args.image.trim().length === 0) {
      return "Error: image must be a non-empty string.";
    }
    if (
      typeof args.instruction !== "string" ||
      args.instruction.trim().length === 0
    ) {
      return "Error: instruction must be a non-empty string.";
    }
    const detail =
      args.detail === "low" || args.detail === "high" || args.detail === "auto"
        ? args.detail
        : undefined;

    let imageUrl: string;
    try {
      imageUrl = await resolveImageUrl(args.image.trim(), ctx);
    } catch (err) {
      ctx.imageAccessLogger?.({
        userId: ctx.userId ?? "unknown",
        tool: "analyze_image_native",
        model: "main",
        status: "error",
        error: (err as Error).message,
      });
      return `Error: could not load image — ${(err as Error).message}`;
    }

    const blocks: ContentBlock[] = [
      {
        type: "text",
        text:
          `[sistem] Gambar berikut diserahkan oleh tool analyze_image_native ` +
          `atas permintaanmu. Ini BUKAN attachment dari user — ini konten yang ` +
          `kamu baca sendiri dengan vision-mu. Instruksi: "${args.instruction.trim()}"`,
      },
      { type: "image_url", image_url: { url: imageUrl, detail } },
    ];
    // Hand the image to the agent loop (out-of-band queue). The loop drains
    // this right after tool results land and injects it as the next user
    // message, so the main model sees the actual pixels.
    ctx.pendingVisionBlocks?.push(blocks);
    ctx.imageAccessLogger?.({
      userId: ctx.userId ?? "unknown",
      tool: "analyze_image_native",
      model: "main",
      status: "success",
    });
    return "Image queued for you to view directly in the next step. Read the injected image and answer the instruction yourself.";
  },
};
