import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

interface Args {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace `old_string` with `new_string` in a file. By default fails if `old_string` is not unique; set `replace_all` to replace every occurrence. Restricted to the project directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to project dir)" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence (default false)",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { path, old_string, new_string, replace_all } = args as Args;
    const full = await resolveWithin(ctx.projectDir, path);
    const content = await readFile(full, "utf8");

    if (old_string === new_string) {
      return "Error: old_string and new_string are identical";
    }

    if (replace_all) {
      const next = content.split(old_string).join(new_string);
      if (next === content) {
        return `Error: old_string not found in ${full}`;
      }
      await writeFile(full, next, "utf8");
      return `Replaced all occurrences in ${full}`;
    }

    const first = content.indexOf(old_string);
    if (first === -1) {
      return `Error: old_string not found in ${full}`;
    }
    const second = content.indexOf(old_string, first + old_string.length);
    if (second !== -1) {
      return "Error: old_string is not unique; pass replace_all=true or include more context";
    }
    const next =
      content.slice(0, first) + new_string + content.slice(first + old_string.length);
    await writeFile(full, next, "utf8");
    return `Edited ${full}`;
  },
};
