import { rm, stat } from "node:fs/promises";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  path: string;
  recursive?: boolean;
  force?: boolean;
}

export const deleteFileTool: Tool = {
  name: "delete_file",
  description:
    "Delete a file or directory from disk. Directories require `recursive: true`. Restricted to paths inside the project directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path (absolute or relative to project dir)" },
      recursive: { type: "boolean", description: "Delete directories recursively. Default false." },
      force: { type: "boolean", description: "Ignore missing paths. Default false." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { path, recursive = false, force = false } = args as Args;
    const full = await resolveWithin(ctx.projectDir, path);

    if (!force) {
      await stat(full);
    }

    await rm(full, { recursive, force });
    return `Deleted ${full}`;
  },
};
