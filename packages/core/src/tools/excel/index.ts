import type { Tool } from "../base.js";
import { excelScriptTool } from "./excel-script.js";

/**
 * The single Excel tool. Replaces the former read_excel / write_excel /
 * write_excel_script trio with one power-tool that reads/modifies/creates
 * .xlsx files via the full exceljs API (formulas, images, charts, styling).
 */
export const excelTools: Tool[] = [excelScriptTool];

export { excelScriptTool };
