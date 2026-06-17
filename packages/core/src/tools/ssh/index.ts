import type { Tool } from "../base.js";
import { sshExecTool } from "./exec.js";

export const sshTools: Tool[] = [sshExecTool];
