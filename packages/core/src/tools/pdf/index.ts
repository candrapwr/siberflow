import type { Tool } from "../base.js";
import { pdfScriptTool } from "./pdf-script.js";

/**
 * The single PDF tool: create or read .pdf files via the `pdf-lib` (create)
 * and `pdfjs-dist` (read) libraries, run inside a sandboxed JS function.
 */
export const pdfTools: Tool[] = [pdfScriptTool];

export { pdfScriptTool };
