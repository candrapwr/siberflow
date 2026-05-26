import type { Message, UsageStats } from "../agent/types.js";

export const SESSION_FORMAT_VERSION = 1;

export interface SessionUsage {
  /** Last LLM call's usage — prompt size = current context. */
  last: UsageStats;
  /** Sum of every LLM call's usage — reflects actual API billing. */
  total: UsageStats;
}

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
  usage: SessionUsage;
}

export interface SessionSummary {
  id: string;
  name: string | null;
  projectDir: string;
  updatedAt: string;
  messageCount: number;
}
