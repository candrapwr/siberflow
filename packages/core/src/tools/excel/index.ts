import type { Tool } from "../base.js";
import { readExcelTool } from "./read.js";
import { writeExcelTool } from "./write.js";
import { writeExcelScriptTool } from "./script.js";

export const excelTools: Tool[] = [readExcelTool, writeExcelTool, writeExcelScriptTool];

export { readExcelTool, writeExcelTool, writeExcelScriptTool };
export * from "./styles.js";
