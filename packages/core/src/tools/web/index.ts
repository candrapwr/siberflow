import type { Tool } from "../base.js";
import { webSearchTool } from "./search.js";

export const webTools: Tool[] = [webSearchTool];
export { webSearchTool };
