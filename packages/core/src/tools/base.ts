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

export interface ToolContext {
  /** Sandbox root — all file operations must resolve inside this directory. */
  projectDir: string;
  /** Present when task tracking is enabled; used by the task_update tool. */
  taskStore?: TaskStore;
  /**
   * Optional extra directory that `read_excel` may read uploaded files from
   * (typically an OS tmp dir scoped per session, so the project folder stays
   * clean). Only `read_excel` honors this field — every other file tool stays
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
