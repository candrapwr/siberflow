import type { ToolSchema } from "../agent/types.js";
import type { TaskStore } from "../agent/tasks.js";

/**
 * Request payload for asking the user a question mid-turn (via the ask_user
 * tool). The host injects an `askUser` callback into ToolContext; the tool
 * awaits it and returns the answer to the model.
 */
export interface AskUserRequest {
  /** Question/prompt text shown to the user. */
  question: string;
  /** Predefined choices (rendered as buttons/list). Omit/empty = free-text only. */
  choices?: string[];
  /** Whether to also show a free-text input alongside choices. Default false. */
  allowFreeText?: boolean;
  /** Optional default selection or placeholder for the free-text input. */
  defaultChoice?: string;
}

export interface AskUserResponse {
  /** "answer" = user picked/typed something; "cancel" = user dismissed the prompt. */
  status: "answer" | "cancel";
  /** The chosen or typed answer (empty string when cancelled). */
  answer: string;
}

export interface BotScriptHost {
  /** Metadata about the active chat/thread. Read-only.
   * Keys include: id, type, title?, username?, messageThreadId?,
   * currentMessageId, currentUserId?, currentUserUsername?. Hosts may add more. */
  readonly chat: Record<string, unknown>;
  // ── existing ──────────────────────────────────────────────────────────────
  sendMessage(text: string): Promise<unknown>;
  sendPhoto(path: string, caption?: string): Promise<unknown>;
  sendDocument(path: string, caption?: string): Promise<unknown>;
  // ── curated Telegram Bot API surface ──────────────────────────────────────
  /** Send a video file from the workdir. */
  sendVideo(path: string, caption?: string): Promise<unknown>;
  /** Send an audio file (shown in the music player) from the workdir. */
  sendAudio(path: string, caption?: string): Promise<unknown>;
  /** Send an animation/GIF from the workdir. */
  sendAnimation(path: string, caption?: string): Promise<unknown>;
  /** Send a voice message (.ogg) from the workdir. */
  sendVoice(path: string, caption?: string): Promise<unknown>;
  /** Send a point on the map. */
  sendLocation(
    latitude: number,
    longitude: number,
    options?: { title?: string; address?: string },
  ): Promise<unknown>;
  /** Send a native poll. `options` are the answer choices (2-10 strings). */
  sendPoll(
    question: string,
    options: string[],
    options2?: { multiple?: boolean; anonymous?: boolean },
  ): Promise<unknown>;
  /** Send an album of photos/videos (same media type) from the workdir. */
  sendMediaGroup(paths: string[], caption?: string): Promise<unknown>;
  /** Edit the text of one of the bot's own messages in the active chat. */
  editMessageText(messageId: number, text: string): Promise<unknown>;
  /** Delete a message in the active chat (bot needs rights in groups). */
  deleteMessage(messageId: number): Promise<unknown>;
  /** Reply to the user's current message with text. */
  reply(text: string): Promise<unknown>;
  /** Fetch info about the active chat (title, type, member count, etc.). */
  getChat(): Promise<unknown>;
  /** Fetch info about a chat member (status, user, join date). */
  getChatMember(userId: number): Promise<unknown>;
}

export interface ToolContext {
  /** Sandbox root — all file operations must resolve inside this directory. */
  projectDir: string;
  /** Present when task tracking is enabled; used by the task_update tool. */
  taskStore?: TaskStore;
  /**
   * Optional extra directory that `excel_script` may read uploaded files from
   * (typically an OS tmp dir scoped per session, so the project folder stays
   * clean). Only `excel_script` honors this field — every other file tool stays
   * sandboxed to `projectDir` and never sees uploaded files.
   */
  uploadDir?: string;
  /**
   * Ask the user a question and await their response. Blocks the tool until
   * the user answers or cancels. Injected by the host (AgentHost /
   * ChatViewProvider) which bridges to the UI. Undefined when no interactive
   * UI is available (e.g. CLI) — tools that rely on it should check and fall
   * back gracefully.
   */
  askUser?: (req: AskUserRequest) => Promise<AskUserResponse>;
  /**
   * Host-specific bot automation surface. Currently injected by the Telegram
   * host for `bot_script`; absent in CLI/Desktop/VS Code unless they provide a
   * bot integration.
   */
  botScript?: BotScriptHost;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

export function toSchema(tool: Tool): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
