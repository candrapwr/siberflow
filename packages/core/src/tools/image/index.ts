import type { Tool } from "../base.js";
import { analyzeImageTool } from "./analyze.js";
import { analyzeImageNativeTool } from "./native-vision.js";
import { imageGenTool } from "./generate.js";

/**
 * Image tools. `analyze_image` describes/OCRs an image via a multimodal
 * provider; `analyze_image_native` injects the image so the MAIN model reads it
 * itself (native-vision mode — hosts swap it in for `analyze_image`); `image_gen`
 * generates or edits images via an external image API. All are opt-in via
 * SIBERFLOW_TOOLS / host settings.
 */
export const imageTools: Tool[] = [
  analyzeImageTool,
  analyzeImageNativeTool,
  imageGenTool,
];

export { analyzeImageTool, analyzeImageNativeTool, imageGenTool };
