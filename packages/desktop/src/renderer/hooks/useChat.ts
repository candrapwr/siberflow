// Central chat state: subscribes to main-process streaming events and exposes
// the message list, busy state, tasks, and notices for the renderer.

import { useCallback, useEffect, useReducer } from "react";
import { ipc } from "../ipc.js";
import type { Task } from "@siberflow/core";
import type {
  BannerInfo,
  CurrentSessionInfo,
  MainEvent,
  SettingsValues,
  UsageInfo,
} from "@shared/protocol";

/** A tool call rendered inside an assistant turn. */
export interface ToolCall {
  name: string;
  args: string;
  result: string | null;
}

/**
 * A single content block within an assistant turn, in stream order.
 * - text: a markdown chunk (several may exist, separated by tool calls)
 * - tool: a tool call box
 */
export type ContentBlock =
  | { kind: "text"; id: number; text: string }
  | { kind: "tool"; id: number; tool: ToolCall };

/** An assistant turn is an ordered list of content blocks. */
export interface AssistantTurn {
  role: "assistant";
  blocks: ContentBlock[];
}

/** A plain user message. */
export interface UserMessage {
  role: "user";
  content: string;
}

type DisplayMessage = UserMessage | AssistantTurn;

interface ChatState {
  ready: boolean;
  requireSettings: boolean;
  mustConfigure: boolean;
  settingsValues: Partial<SettingsValues> | null;
  hasApiKey: boolean;
  hasMultimodalApiKey: boolean;
  hasExaApiKey: boolean;
  banner: BannerInfo | null;
  session: CurrentSessionInfo | null;
  hideTools: boolean;
  tasksEnabled: boolean;
  messages: DisplayMessage[];
  tasks: Task[];
  /** Snapshot of the initial task plan (set once per turn via task-plan event). */
  taskPlan: Task[] | null;
  /** Tool names currently enabled in settings (drives composer upload toggle). */
  enabledTools: string[];
  /** Active ask_user prompt from the agent (renders a modal); null when none. */
  askUserPrompt: {
    id: string;
    question: string;
    choices: string[];
    allowFreeText: boolean;
    defaultChoice?: string;
  } | null;
  busy: boolean;
  stopping: boolean;
  notices: Array<{ id: number; kind: "info" | "error" | "warn"; text: string }>;
  showActions: boolean;
  /** Latest usage stats — `last.promptTokens` is the context window size that
   * will be sent to the LLM on the next request (not the billing total). */
  usage: UsageInfo | null;
}

const initial: ChatState = {
  ready: false,
  requireSettings: false,
  mustConfigure: false,
  settingsValues: null,
  hasApiKey: false,
  hasMultimodalApiKey: false,
  hasExaApiKey: false,
  banner: null,
  session: null,
  hideTools: true,
  tasksEnabled: true,
  messages: [],
  tasks: [],
  taskPlan: null,
  enabledTools: ["read_file", "write_file", "edit_file", "copy_file", "list_dir", "delete_file", "grep"],
  askUserPrompt: null,
  busy: false,
  stopping: false,
  notices: [],
  showActions: false,
  usage: null,
};

type Action =
  | { type: "reset" }
  | { type: "dismiss-notice"; id: number }
  | { type: "user-send"; content: string }
  | { type: "regenerate" }
  | { type: "edit-last"; content: string }
  | { type: "clear-ask-user" }
  | { type: "event"; event: MainEvent };

// Monotonic id generators (kept module-level; ids only need to be unique).
let blockSeq = 0;
let noticeSeq = 0;

/** Type guard: an assistant turn vs a plain user message. */
export function isAssistantTurn(m: DisplayMessage): m is AssistantTurn {
  return m.role === "assistant";
}

/** Deep-ish clone of an assistant turn so React sees a new reference. */
function cloneTurn(turn: AssistantTurn): AssistantTurn {
  return { role: "assistant", blocks: turn.blocks.map((b) => ({ ...b })) };
}

/** Immutably update the last message in the list, if it's an assistant turn. */
function updateLastTurn(
  msgs: DisplayMessage[],
  fn: (turn: AssistantTurn) => void,
): DisplayMessage[] {
  const out = [...msgs];
  const last = out[out.length - 1];
  if (!last || last.role !== "assistant") return out;
  const clone = cloneTurn(last);
  fn(clone);
  out[out.length - 1] = clone;
  return out;
}

/**
 * Remove the trailing assistant turn if it has NO visible content: no text
 * blocks and no non-hidden tool blocks. This handles the common case where a
 * tool-call iteration only emitted hidden `task_update` calls — without this,
 * the empty turn would render its `thinking-dots` placeholder forever and a
 * new empty turn would stack on top at the next iteration. Non-empty turns
 * (real text or visible tool calls) are always preserved.
 */
function dropTrailingEmptyAssistantTurn(msgs: DisplayMessage[]): DisplayMessage[] {
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant") return msgs;
  const hasVisible = last.blocks.some(
    (b) => !(b.kind === "tool" && b.tool.name === "__hidden__"),
  );
  return hasVisible ? msgs : msgs.slice(0, -1);
}

function reducer(state: ChatState, action: Action): ChatState {
  if (action.type === "reset") {
    return {
      ...initial,
      ready: state.ready,
      banner: state.banner,
      session: state.session,
      hideTools: state.hideTools,
      tasksEnabled: state.tasksEnabled,
      taskPlan: null,
    };
  }

  if (action.type === "dismiss-notice") {
    return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
  }

  if (action.type === "user-send") {
    // Optimistically show the user message immediately, before the assistant
    // turn streams in. The backend also persists it; this is display-only.
    return {
      ...state,
      showActions: false,
      messages: [...state.messages, { role: "user", content: action.content }],
    };
  }

  if (action.type === "regenerate") {
    // Drop the trailing assistant turn (and any notices) so the regenerated
    // response doesn't stack on top of the old one. The last user message is
    // kept since the backend re-sends it after rewinding.
    const msgs = [...state.messages];
    while (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs.pop();
      } else {
        break;
      }
    }
    return { ...state, messages: msgs, showActions: false };
  }

  if (action.type === "edit-last") {
    // Edit mode: drop the trailing assistant turn AND the last user message,
    // then optimistically show the edited prompt. The backend rewinds its own
    // history and re-sends, so this keeps the UI in sync.
    const msgs = [...state.messages];
    while (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs.pop();
      } else {
        break;
      }
    }
    // Drop the trailing user message too.
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === "user") msgs.pop();
    }
    return {
      ...state,
      messages: [...msgs, { role: "user", content: action.content }],
      showActions: false,
    };
  }

  if (action.type === "clear-ask-user") {
    return { ...state, askUserPrompt: null };
  }

  const e = action.event;
  switch (e.type) {
    case "ready":
      return {
        ...state,
        ready: true,
        requireSettings: false,
        settingsValues: e.values,
        banner: e.banner,
        session: e.session,
        hideTools: e.hideTools,
        tasksEnabled: e.tasksEnabled,
        enabledTools: e.enabledTools,
        messages: [],
        tasks: [],
        // usage is filled by the follow-up "usage" event (postReady emits it).
        usage: null,
        showActions: false,
      };

    case "require-settings":
      return {
        ...state,
        requireSettings: true,
        mustConfigure: e.mustConfigure,
        settingsValues: e.values,
        hasApiKey: e.hasApiKey,
        hasMultimodalApiKey: e.hasMultimodalApiKey,
        hasExaApiKey: e.hasExaApiKey,
      };

    case "settings-saved":
      return { ...state, requireSettings: false, settingsValues: e.values };

    case "session-changed":
      // When the active session becomes null (e.g. deleted), clear the chat
      // area so the welcome screen shows and the composer is hidden.
      if (e.session === null) {
        return {
          ...state,
          session: null,
          messages: [],
          tasks: [],
          showActions: false,
          busy: false,
          stopping: false,
          usage: null,
        };
      }
      return { ...state, session: e.session };

    case "session-list":
      return state; // handled in useSessions

    case "history":
      return {
        ...state,
        messages: e.messages.map((m) =>
          m.role === "user"
            ? { role: "user", content: m.content }
            : { role: "assistant", blocks: [{ kind: "text", id: ++blockSeq, text: m.content }] },
        ),
        showActions: e.messages.some((m) => m.role === "assistant"),
      };

    case "assistant-start":
      // Begin a new assistant turn with an empty block list.
      return {
        ...state,
        busy: true,
        stopping: false,
        showActions: false,
        messages: [...state.messages, { role: "assistant", blocks: [] }],
      };

    case "assistant-content":
      // Append text deltas to the last text block, or create one.
      return {
        ...state,
        messages: updateLastTurn(state.messages, (turn) => {
          const last = turn.blocks[turn.blocks.length - 1];
          if (last && last.kind === "text") {
            last.text += e.delta;
          } else {
            turn.blocks.push({ kind: "text", id: ++blockSeq, text: e.delta });
          }
        }),
      };

    case "tool-call-start": {
      // Ensure an assistant turn exists — tool-call-start may arrive before
      // any assistant-start in edge cases (defensive guard).
      let msgs = state.messages;
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") {
        msgs = [...msgs, { role: "assistant", blocks: [] }];
      }
      return {
        ...state,
        messages: updateLastTurn(msgs, (turn) => {
          turn.blocks.push({
            kind: "tool",
            id: e.index,
            tool: {
              name: e.name === "task_update" ? "__hidden__" : e.name,
              args: "",
              result: null,
            },
          });
        }),
      };
    }

    case "tool-call-args":
      // Append arg deltas to the tool block with matching id.
      return {
        ...state,
        messages: updateLastTurn(state.messages, (turn) => {
          const blk = turn.blocks.find(
            (b) => b.kind === "tool" && b.id === e.index,
          );
          if (blk && blk.kind === "tool" && blk.tool.name !== "__hidden__") {
            blk.tool.args += e.delta;
          }
        }),
      };

    case "tool-result":
      // Attach the result to the matching tool block.
      return {
        ...state,
        messages: updateLastTurn(state.messages, (turn) => {
          const blk = turn.blocks.find(
            (b) => b.kind === "tool" && b.id === e.index,
          );
          if (blk && blk.kind === "tool" && blk.tool.name !== "__hidden__") {
            blk.tool.result = e.result;
          }
        }),
      };

    case "iteration-end":
      // iteration-end fires after each assistant message in a tool-call loop;
      // the next assistant-start will push a fresh turn. If the just-finished
      // turn is empty (e.g. the model only emitted hidden `task_update` calls
      // and no text), drop it so its thinking-dots placeholder doesn't linger
      // and stack across iterations. A non-empty turn (has visible text or
      // tool blocks) is kept as-is.
      return {
        ...state,
        messages: dropTrailingEmptyAssistantTurn(state.messages),
      };

    case "assistant-end":
      return {
        ...state,
        busy: false,
        stopping: false,
        showActions: !state.stopping,
      };

    case "task-plan":
      return { ...state, taskPlan: e.tasks };

    case "tasks":
      return { ...state, tasks: e.tasks };

    case "context-optimized":
      return state;

    case "max-iterations":
      return {
        ...state,
        notices: [
          ...state.notices,
          { id: ++noticeSeq, kind: "warn", text: `Reached ${e.limit}-iteration limit.` },
        ],
      };

    case "usage":
      return { ...state, usage: e.usage };

    case "info":
      if (e.message === "__noop__") return state; // legacy safety
      return {
        ...state,
        notices: [...state.notices, { id: ++noticeSeq, kind: "info", text: e.message }],
      };

    case "error":
      return {
        ...state,
        notices: [...state.notices, { id: ++noticeSeq, kind: "error", text: e.message }],
      };

    case "ask-user":
      return {
        ...state,
        askUserPrompt: {
          id: e.id,
          question: e.question,
          choices: e.choices,
          allowFreeText: e.allowFreeText,
          ...(e.defaultChoice ? { defaultChoice: e.defaultChoice } : {}),
        },
      };

    default:
      return state;
  }
}

export function useChat() {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    const unsubscribe = ipc().onEvent((event) => {
      dispatch({ type: "event", event });
    });
    void ipc().init();
    return unsubscribe;
  }, []);

  const dismissNotice = useCallback((id: number) => {
    dispatch({ type: "dismiss-notice", id });
  }, []);

  /** Send a prompt: show it immediately, then kick off the backend turn. */
  const sendMessage = useCallback((content: string) => {
    const text = content.trim();
    if (!text) return;
    dispatch({ type: "user-send", content: text });
    void ipc().send(text);
  }, []);

  /** Clear the trailing assistant turn(s) before the backend regenerates. */
  const clearForRegenerate = useCallback(() => {
    dispatch({ type: "regenerate" });
  }, []);

  /** Edit mode: replace the last user message + drop its assistant response. */
  const editLast = useCallback((content: string) => {
    dispatch({ type: "edit-last", content });
  }, []);

  /** Clear the active ask_user prompt (called by the modal after the user answers). */
  const clearAskUserPrompt = useCallback(() => {
    dispatch({ type: "clear-ask-user" });
  }, []);

  return { state, dismissNotice, sendMessage, clearForRegenerate, editLast, clearAskUserPrompt };
}
