import type { Tool } from "../base.js";
import { analyzeImageTool } from "./analyze.js";
import { imageGenTool } from "./generate.js";

/**
 * Image tools. `analyze_image` describes/OCRs an image via a multimodal
 * provider; `image_gen` generates or edits images via an external image API.
 * Both are opt-in via SIBERFLOW_TOOLS / host settings.
 */
export const imageTools: Tool[] = [analyzeImageTool, imageGenTool];

export { analyzeImageTool, imageGenTool };
