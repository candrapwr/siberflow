import { readdir } from "node:fs/promises";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  path?: string;
}

export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "List entries in a directory (non-recursive). Defaults to the project directory. Restricted to paths inside the project directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (absolute or relative to project dir)" },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { path } = args as Args;
    const full = await resolveWithin(ctx.projectDir, path ?? ".");
    const entries = await readdir(full, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
      .join("\n");
  },
};
