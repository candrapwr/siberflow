// Central chat state: subscribes to main-process streaming events and exposes
// the message list, busy state, tasks, and notices for the renderer.

import { useCallback, useEffect, useReducer } from "react";
import { ipc } from "../ipc.js";
import type { Task } from "@siberflow/core";
import type {
  BannerInfo,
  CurrentSessionInfo,
  MainEvent,
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
  settingsValues: { provider: string } | null;
  hasApiKey: boolean;
  banner: BannerInfo | null;
  session: CurrentSessionInfo | null;
  hideTools: boolean;
  tasksEnabled: boolean;
  messages: DisplayMessage[];
  tasks: Task[];
  /** Snapshot of the initial task plan (set once per turn via task-plan event). */
  taskPlan: Task[] | null;
  busy: boolean;
  stopping: boolean;
  notices: Array<{ id: number; kind: "info" | "error" | "warn"; text: string }>;
  showActions: boolean;
}

const initial: ChatState = {
  ready: false,
  requireSettings: false,
  mustConfigure: false,
  settingsValues: null,
  hasApiKey: false,
  banner: null,
  session: null,
  hideTools: true,
  tasksEnabled: true,
  messages: [],
  tasks: [],
  taskPlan: null,
  busy: false,
  stopping: false,
  notices: [],
  showActions: false,
};

type Action =
  | { type: "reset" }
  | { type: "dismiss-notice"; id: number }
  | { type: "user-send"; content: string }
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

  const e = action.event;
  switch (e.type) {
    case "ready":
      return {
        ...state,
        ready: true,
        requireSettings: false,
        banner: e.banner,
        session: e.session,
        hideTools: e.hideTools,
        tasksEnabled: e.tasksEnabled,
        messages: [],
        showActions: false,
      };

    case "require-settings":
      return {
        ...state,
        requireSettings: true,
        mustConfigure: e.mustConfigure,
        settingsValues: e.values,
        hasApiKey: e.hasApiKey,
      };

    case "settings-saved":
      return { ...state, requireSettings: false };

    case "session-changed":
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
      // iteration-end fires after each assistant message; the NEXT
      // assistant-start creates a fresh turn. No segment manipulation needed.
      return state;

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
      return state;

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

  return { state, dismissNotice, sendMessage };
}
