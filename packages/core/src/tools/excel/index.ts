import type { Tool } from "../base.js";
import { readExcelTool } from "./read.js";
import { writeExcelTool } from "./write.js";

export const excelTools: Tool[] = [readExcelTool, writeExcelTool];

export { readExcelTool, writeExcelTool };
export * from "./styles.js";
