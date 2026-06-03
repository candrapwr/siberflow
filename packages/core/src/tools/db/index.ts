import type { Tool } from "../base.js";
import { dbQueryTool } from "./query.js";

export const dbTools: Tool[] = [dbQueryTool];
