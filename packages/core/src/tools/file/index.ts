import type { Tool } from "../base.js";
import { readFileTool } from "./read.js";
import { writeFileTool } from "./write.js";
import { editFileTool } from "./edit.js";
import { copyFileTool } from "./copy.js";
import { listDirTool } from "./list.js";
import { deleteFileTool } from "./delete.js";
import { grepTool } from "./grep.js";

export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  copyFileTool,
  listDirTool,
  deleteFileTool,
  grepTool,
];
