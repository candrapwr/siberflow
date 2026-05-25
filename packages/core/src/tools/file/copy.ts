import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  source: string;
  destination: string;
  overwrite?: boolean;
}

export const copyFileTool: Tool = {
  name: "copy_file",
  description:
    "Copy a file from source to destination. Fails if destination exists unless `overwrite` is true. Both paths must be inside the project directory.",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "Source file path" },
      destination: { type: "string", description: "Destination file path" },
      overwrite: { type: "boolean", description: "Overwrite if destination exists" },
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { source, destination, overwrite } = args as Args;
    const src = await resolveWithin(ctx.projectDir, source);
    const dst = await resolveWithin(ctx.projectDir, destination);
    await mkdir(dirname(dst), { recursive: true });
    const mode = overwrite ? 0 : 1; // 1 = COPYFILE_EXCL
    await copyFile(src, dst, mode);
    return `Copied ${src} -> ${dst}`;
  },
};
