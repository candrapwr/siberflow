import { readFile } from "node:fs/promises";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  path: string;
  offset?: number;
  limit?: number;
}

/**
 * When pre-truncation is enabled and the caller didn't specify a range, cap
 * the returned content to this many lines. ~200 lines ≈ 8K tokens — enough to
 * see a file's structure and edit anchors without bloating context. The
 * truncated notice tells the model exactly how to continue reading.
 */
const PRE_TRUNCATE_MAX_LINES = 200;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from disk. Optionally read a line range with `offset` (1-based) and `limit`. Restricted to files inside the project directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to project dir)" },
      offset: { type: "integer", description: "1-based starting line", minimum: 1 },
      limit: { type: "integer", description: "Max lines to read", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { path, offset, limit } = args as Args;
    const full = await resolveWithin(ctx.projectDir, path);
    const content = await readFile(full, "utf8");
    if (offset === undefined && limit === undefined) {
      // Pre-truncate: when enabled and no explicit range was requested, cap to
      // the first N lines so a huge file doesn't flood context. Respect an
      // explicit offset/limit (the caller asked for a specific window).
      if (ctx.preTruncate !== false) {
        const lines = content.split("\n");
        if (lines.length > PRE_TRUNCATE_MAX_LINES) {
          const head = lines.slice(0, PRE_TRUNCATE_MAX_LINES).join("\n");
          const remaining = lines.length - PRE_TRUNCATE_MAX_LINES;
          return `${head}\n\n[truncated — ${remaining} more line${remaining === 1 ? "" : "s"}. Use offset=${PRE_TRUNCATE_MAX_LINES + 1} to continue reading.]`;
        }
      }
      return content;
    }
    const lines = content.split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit !== undefined ? start + limit : lines.length;
    return lines.slice(start, end).join("\n");
  },
};
