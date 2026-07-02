import type { Tool } from "../base.js";
import { textToSpeechTool, speechToTextTool } from "./voice.js";

export const speechTools: Tool[] = [textToSpeechTool, speechToTextTool];
export { textToSpeechTool, speechToTextTool };
