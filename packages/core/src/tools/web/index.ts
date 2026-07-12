import type { Tool } from "../base.js";
import { webSearchTool } from "./search.js";
import { downloadFileTool } from "./download.js";

export const webTools: Tool[] = [webSearchTool];
export { webSearchTool, downloadFileTool };
