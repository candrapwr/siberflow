import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  path: string;
  content: string;
}

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Write text content to a file, overwriting if it exists. Parent directories are created as needed. Restricted to the project directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to project dir)" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { path, content } = args as Args;
    const full = await resolveWithin(ctx.projectDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    return `Wrote ${content.length} bytes to ${full}`;
  },
};
