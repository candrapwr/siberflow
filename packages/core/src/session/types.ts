import type { Message } from "../agent/types.js";

export const SESSION_FORMAT_VERSION = 1;

export interface Session {
  version: number;
  id: string;
  name: string | null;
  projectDir: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  name: string | null;
  projectDir: string;
  updatedAt: string;
  messageCount: number;
}
