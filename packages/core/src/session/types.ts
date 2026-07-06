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
   * user id (as string) → a compact member record (username, display name).
   * Built incrementally as members send messages; persisted so it survives bot
   * restarts alongside the chat history. Absent/empty in private chats and
   * sessions that predate the feature.
   */
  knownMembers?: Record<string, { username?: string; name?: string }>;
  /**
   * LLM-generated narrative summary of older conversation turns, produced by
   * the "compact" context-optimization mode. The summary covers messages
   * `[0 .. upToIndex]` inclusive; messages after that index are still kept
   * verbatim in `messages` and appended after the summary at request time.
   * Absent for sessions using other optimize modes or before the first
   * compaction.
   */
  summary?: SessionSummaryState;
}

/**
 * Persisted state of an LLM-generated context summary. `upToIndex` is an
 * index into `Session.messages` — the summary narrates messages `0..upToIndex`
 * inclusive; everything after is still sent verbatim. Updated incrementally
 * each turn the "compact" mode is active, so the summary rolls forward as the
 * conversation grows.
 */
export interface SessionSummaryState {
  /** The narrative summary text, prepended as a pseudo-system message. */
  text: string;
  /** Inclusive index into Session.messages the summary covers. */
  upToIndex: number;
  /** ISO timestamp of the last summary update. */
  updatedAt: string;
}

export interface SessionSummary {
  id: string;
  name: string | null;
  projectDir: string;
  updatedAt: string;
  messageCount: number;
}
