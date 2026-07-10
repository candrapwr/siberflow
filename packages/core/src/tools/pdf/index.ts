import type { Tool } from "../base.js";
import { pdfScriptTool } from "./pdf-script.js";

/**
 * The single PDF tool: create or read .pdf files via Python (reportlab for
 * creation, pdfplumber for reading, Tesseract for OCR). Runs via the shared
 * Python runner — same execution model as the voice tools.
 */
export const pdfTools: Tool[] = [pdfScriptTool];

export { pdfScriptTool };
