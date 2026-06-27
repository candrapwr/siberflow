import type { Tool } from "../base.js";
import { docxScriptTool } from "./docx-script.js";

/**
 * The single Word-document tool: create or read .docx files via the `docx`
 * (create) and `mammoth` (read) libraries, run inside a sandboxed JS function.
 */
export const docxTools: Tool[] = [docxScriptTool];

export { docxScriptTool };
