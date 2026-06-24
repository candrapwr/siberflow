import type { Tool } from "../base.js";
import { askUserTool } from "./ask-user.js";

/**
 * Built-in interaction tools (ask_user). These are always registered — they
 * are core to the agent UX, not opt-in like exec/db/ssh/excel/web.
 */
export const interactionTools: Tool[] = [askUserTool];

export { askUserTool };
