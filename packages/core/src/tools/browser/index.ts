import type { Tool } from "../base.js";
import { runBrowserTool } from "./browser.js";

/**
 * Browser automation tools (run_browser — headless Chrome/Edge via Puppeteer).
 * Opt-in via enabledTools; doesn't require a workdir (network-only).
 */
export const browserTools: Tool[] = [runBrowserTool];

export { runBrowserTool };
