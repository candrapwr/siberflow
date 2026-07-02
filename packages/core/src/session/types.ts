import type { Message, UsageStats } from "../agent/types.js";
import type { Task } from "../agent/tasks.js";

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
  /** Task checklist (present when task tracking is/was used). */
  tasks?: Task[];
  /**
   * Known chat members for group/supergroup Telegram sessions. Maps Telegram
   * user id → username (lowercase, without @). Built incrementally as members
   * send messages; persisted so it survives bot restarts alongside the chat
   * history. Absent/empty in private chats and sessions that predate the feature.
   */
  knownMembers?: Record<string, string>;
}

export interface SessionSummary {
  id: string;
  name: string | null;
  projectDir: string;
  updatedAt: string;
  messageCount: number;
}
