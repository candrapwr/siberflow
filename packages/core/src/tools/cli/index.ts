import type { Tool } from "../base.js";
import { execTool } from "./exec.js";

export const cliTools: Tool[] = [execTool];
