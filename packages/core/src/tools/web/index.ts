import type { Tool } from "../base.js";
import { webScrapeTool } from "./scrape.js";

export const webTools: Tool[] = [webScrapeTool];

export { webScrapeTool };
export { ensureChromium, isChromiumInstalled } from "./ensure-chromium.js";
