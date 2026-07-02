// Root component: wires sidebar + chat area + modals. Holds the top-level
// settings-modal state and delegates streaming state to useChat.

import { useCallback, useEffect, useRef, useState } from "react";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
import { ipc } from "./ipc.js";
import { useChat, isAssistantTurn } from "./hooks/useChat.js";
import { useSessions } from "./hooks/useSessions.js";
import { Sidebar } from "./components/Sidebar.js";
import { Composer } from "./components/Composer.js";
import { UserMessage, AssistantMessage } from "./components/Message.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { EmptyState } from "./components/EmptyState.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { AskUserModal } from "./components/AskUserModal.js";
import { ArrowDownIcon, FolderIcon } from "./components/icons.js";
import type { SettingsValues } from "@shared/protocol";

/** Compact token count: 1234 → "1.2k", 12345 → "12k". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

/** Return the last path segment of a filesystem path. */
function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export default function App() {
  const { state, dismissNotice, sendMessage, clearForRegenerate, editLast, clearAskUserPrompt } = useChat();
  const sessions = useSessions();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsData, setSettingsData] = useState<{
    values: SettingsValues;
    hasApiKey: boolean;
    hasMultimodalApiKey: boolean;
    hasExaApiKey: boolean;
    mustConfigure: boolean;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  // Edit flow: when non-null, the composer is prefilled with this text and
  // the next send goes through editLast instead of a normal send.
  const [editPrefill, setEditPrefill] = useState<string | null>(null);

  // Resizable sidebar: drag the handle on the right edge to resize.
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const draggingRef = useRef(false);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
      setSidebarWidth(w);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // When the backend demands settings, open the modal automatically.
  useEffect(() => {
    if (state.requireSettings && state.settingsValues) {
      setSettingsData({
        values: state.settingsValues as unknown as SettingsValues,
        hasApiKey: state.hasApiKey,
        hasMultimodalApiKey: state.hasMultimodalApiKey,
        hasExaApiKey: state.hasExaApiKey,
        mustConfigure: state.mustConfigure,
      });
      setShowSettings(true);
    }
  }, [state.requireSettings, state.settingsValues, state.hasApiKey, state.hasMultimodalApiKey, state.hasExaApiKey, state.mustConfigure]);

  // Auto-dismiss notices after 5s — one timer per notice id, cleaned up on unmount.
  // Errors persist (user-visible) until dismissed manually; info/warn auto-dismiss.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const n of state.notices) {
      if (n.kind === "error") continue; // errors stay until clicked away
      const t = setTimeout(() => dismissNotice(n.id), 5000);
      timers.push(t);
    }
    return () => timers.forEach((t) => clearTimeout(t));
  }, [state.notices, dismissNotice]);

  // Keep the session list fresh and track the active session.
  // NOTE: depend only on `state.session?.id` (a stable string), NOT on the
  // `sessions` object — useSessions returns a new object every render, so
  // depending on it would cause an infinite re-render loop → 100% CPU.
  useEffect(() => {
    if (state.session) {
      sessions.setActiveId(state.session.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.session?.id]);

  // Refresh the sidebar list when the active session's name changes — this
  // picks up auto-renames (first-prompt substring) so the sidebar shows the
  // new name without a manual reload.
  // NOTE: depend only on the name string, not the `sessions` object (see above).
  useEffect(() => {
    if (state.session?.name) {
      void sessions.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.session?.name]);

  // Track whether the user is pinned to the bottom of the scroll area.
  // Only auto-scroll on new content if they haven't scrolled up to read.
  const stickToBottomRef = useRef(true);

  // When switching sessions, re-pin to bottom so the new conversation shows
  // its latest messages.
  useEffect(() => {
    stickToBottomRef.current = true;
    const el = messagesScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.session?.id]);

  // Auto-scroll to bottom on new streaming content — but ONLY if the user
  // is currently pinned to the bottom. If they scrolled up to read history,
  // respect that and don't yank them back down.
  useEffect(() => {
    if (!state.busy || !stickToBottomRef.current) return;
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.messages, state.busy]);

  const onScroll = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const openSettings = useCallback(async () => {
    const data = await ipc().getSettings();
    setSettingsData({ ...data, mustConfigure: false });
    setShowSettings(true);
  }, []);

  // New chat: folder picker is optional — user may start without a workdir
  // and set one later from the topbar.
  const newChat = useCallback(async () => {
    await sessions.newSession(null, null);
  }, [sessions]);

  const renameSession = useCallback(
    async (id: string, name: string) => {
      await ipc().renameSession(id, name);
      await sessions.refresh();
    },
    [sessions],
  );

  /** Pick a folder and set it as the current session's workdir. */
  const changeWorkdir = useCallback(async () => {
    const folder = await ipc().pickFolder();
    if (!folder) return;
    await ipc().setWorkdir(folder);
  }, []);

  const onRegenerate = useCallback(() => {
    // Clear the displayed assistant turn so the regenerated response doesn't
    // stack on top of the old one. The backend rewinds its own history.
    clearForRegenerate();
    void ipc().regenerate();
  }, [clearForRegenerate]);

  const onEdit = useCallback(() => {
    // Pre-fill the composer with the last user message so the user can edit it,
    // then resend. We do NOT call the backend yet — that happens on send.
    const lastUser = [...state.messages].reverse().find((m) => "role" in m && m.role === "user");
    if (lastUser && "content" in lastUser) {
      setEditPrefill(lastUser.content);
    }
  }, [state.messages]);

  /** Composer send: routes to editLast when we're in edit mode, else a normal
   * send. Also clears the edit prefill so the next send is normal again. */
  const onComposerSend = useCallback(
    (content: string) => {
      if (editPrefill !== null) {
        // Edit mode: drop the trailing user+assistant and show the edited
        // prompt optimistically, then ask the backend to re-run.
        editLast(content);
        void ipc().editLast(content);
        setEditPrefill(null);
      } else {
        sendMessage(content);
      }
    },
    [editPrefill, editLast, sendMessage],
  );

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;

      // Cmd+N / Ctrl+N → new chat
      if (isMeta && e.key === "n") {
        e.preventDefault();
        newChat();
        return;
      }

      // Cmd+K / Ctrl+K → focus composer
      if (isMeta && e.key === "k") {
        e.preventDefault();
        const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea");
        ta?.focus();
        return;
      }

      // Cmd+, / Ctrl+, → open settings
      if (isMeta && e.key === ",") {
        e.preventDefault();
        openSettings();
        return;
      }

      // Escape → dismiss all notices
      if (e.key === "Escape") {
        const notices = state.notices;
        const last = notices[notices.length - 1];
        if (last) {
          dismissNotice(last.id);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newChat, openSettings, state.notices, dismissNotice]);

  const isEmpty = state.messages.length === 0;

  return (
    <div className="app">
      <div className="sidebar-wrapper" style={{ width: sidebarWidth }}>
        <Sidebar
          sessions={sessions.sessions}
          activeId={sessions.activeId}
          currentFolder={state.session?.projectDir || null}
          onSelect={(id) => void sessions.loadSession(id)}
          onDelete={(id) => void sessions.deleteSession(id)}
          onRename={(id, name) => void renameSession(id, name)}
          onNewChat={newChat}
          onOpenSettings={openSettings}
        />
        <div className="sidebar-resizer" onMouseDown={startDrag} title="Drag to resize" />
      </div>

      <main className="chat-area">
        <header className="topbar">
          <span className="topbar-title">
            {state.session?.name ?? "New chat"}
          </span>
          {state.banner && (
            <span className="topbar-meta">
              {state.banner.provider} · {state.banner.model}
            </span>
          )}
          {state.usage && (
            <span
              className="topbar-tokens"
              title={`Turn total — prompt (input to model): ${state.usage.last.promptTokens.toLocaleString()}\ncompletion (model output): ${state.usage.last.completionTokens.toLocaleString()}`}
            >
              <span className="token-prompt">{formatTokens(state.usage.last.promptTokens)}</span>
              <span className="token-sep">/</span>
              <span className="token-completion">{formatTokens(state.usage.last.completionTokens)}</span>
            </span>
          )}
          {state.session && (
            <button
              className={`topbar-workdir ${state.session.projectDir ? "" : "empty"}`}
              onClick={changeWorkdir}
              title={
                state.session.projectDir
                  ? `Workdir: ${state.session.projectDir}\nClick to change`
                  : "No working directory — file & exec tools disabled\nClick to set one"
              }
            >
              <FolderIcon size={12} />
              <span>{state.session.projectDir ? basename(state.session.projectDir) : "No folder"}</span>
            </button>
          )}
        </header>

        <div className="chat-scroll-area" ref={messagesScrollRef} onScroll={onScroll}>
          <div className="chat-center">
            <div className="messages">
              {isEmpty ? (
                <EmptyState
                  hasSession={!!state.session}
                  onPick={() => {}}
                  onNewChat={newChat}
                />
              ) : (
                state.messages.map((m, i) => {
                  if (isAssistantTurn(m)) {
                    const isLast = i === state.messages.length - 1;
                    return (
                      <AssistantMessage
                        key={i}
                        turn={m}
                        hideTools={state.hideTools}
                        showActions={isLast && state.showActions && !state.busy}
                        onRegenerate={onRegenerate}
                        onEdit={onEdit}
                      />
                    );
                  }
                  // user message
                  return <UserMessage key={i} content={m.content} />;
                })
              )}

              {/* Notices */}
              {state.notices.map((n) => (
                <div key={n.id} className={`notice ${n.kind}`}>
                  {n.text}
                </div>
              ))}

              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>

        {/* Floating task panel — top-right of the chat area (only with active session) */}
        {state.session && state.tasks.length > 0 && (
          <TaskPanel tasks={state.tasks} taskPlan={state.taskPlan} />
        )}

        {showJump && state.session && (
          <button
            className="jump-bottom visible"
            onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })}
          >
            <ArrowDownIcon size={14} />
          </button>
        )}

        {/* Composer only when a session is active */}
        {state.session && (
          <div className="chat-center composer-wrap">
            <Composer
              busy={state.busy}
              onSend={onComposerSend}
              autoFocusKey={`${state.session.id}:${state.busy}`}
              prefill={editPrefill ?? undefined}
              hasWorkdir={!!state.session.projectDir}
              docEnabled={
                state.enabledTools.includes("excel_script") ||
                state.enabledTools.includes("docx_script") ||
                state.enabledTools.includes("pdf_script")
              }
            />
          </div>
        )}
      </main>

      {showSettings && settingsData && (
        <SettingsModal
          values={settingsData.values}
          hasApiKey={settingsData.hasApiKey}
          hasMultimodalApiKey={settingsData.hasMultimodalApiKey}
          hasExaApiKey={settingsData.hasExaApiKey}
          mustConfigure={settingsData.mustConfigure}
          onClose={() => {
            setShowSettings(false);
            setSettingsData(null);
          }}
        />
      )}

      {state.askUserPrompt && (
        <AskUserModal prompt={state.askUserPrompt} onClose={clearAskUserPrompt} />
      )}
    </div>
  );
}
