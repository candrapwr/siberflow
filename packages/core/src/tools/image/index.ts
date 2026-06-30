import type { Tool } from "../base.js";
import { analyzeImageTool } from "./analyze.js";

/**
 * Image analysis tool backed by a configured OpenAI-compatible multimodal
 * provider. Opt-in via SIBERFLOW_TOOLS / host settings.
 */
export const imageTools: Tool[] = [analyzeImageTool];

export { analyzeImageTool };
