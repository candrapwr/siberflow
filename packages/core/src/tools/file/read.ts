import { readFile } from "node:fs/promises";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  path: string;
  offset?: number;
  limit?: number;
}

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
    if (offset === undefined && limit === undefined) return content;
    const lines = content.split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit !== undefined ? start + limit : lines.length;
    return lines.slice(start, end).join("\n");
  },
};
