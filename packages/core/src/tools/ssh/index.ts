import type { Tool } from "../base.js";
import { sshExecTool } from "./exec.js";
import { sftpTool } from "./sftp.js";

export const sshTools: Tool[] = [sshExecTool, sftpTool];
