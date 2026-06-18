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
import { ArrowDownIcon } from "./components/icons.js";
import type { SettingsValues } from "@shared/protocol";

/** Compact token count: 1234 → "1.2k", 12345 → "12k". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

export default function App() {
  const { state, dismissNotice, sendMessage } = useChat();
  const sessions = useSessions();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsData, setSettingsData] = useState<{
    values: SettingsValues;
    hasApiKey: boolean;
    mustConfigure: boolean;
  } | null>(null);
  const [composerPrefill, setComposerPrefill] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);

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
        mustConfigure: state.mustConfigure,
      });
      setShowSettings(true);
    }
  }, [state.requireSettings, state.settingsValues, state.hasApiKey, state.mustConfigure]);

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
  useEffect(() => {
    if (state.session) {
      sessions.setActiveId(state.session.id);
    }
  }, [state.session, sessions]);

  // Refresh the sidebar list when the active session's name changes — this
  // picks up auto-renames (first-prompt substring) so the sidebar shows the
  // new name without a manual reload.
  useEffect(() => {
    if (state.session?.name) {
      void sessions.refresh();
    }
  }, [state.session?.name, sessions]);

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

  const newChat = useCallback(async () => {
    const folder = await ipc().pickFolder();
    if (!folder) return;
    await sessions.newSession(folder, null);
    // The agent host will emit a fresh "ready"/"history" (empty) automatically.
  }, [sessions]);

  const renameSession = useCallback(
    async (id: string, name: string) => {
      await ipc().renameSession(id, name);
      await sessions.refresh();
    },
    [sessions],
  );

  const onRegenerate = useCallback(() => {
    void ipc().regenerate();
  }, []);

  const onEdit = useCallback(() => {
    // Prefill composer with the last user message (renderer-local convenience).
    const lastUser = [...state.messages].reverse().find((m) => "role" in m && m.role === "user");
    if (lastUser && "content" in lastUser) {
      void ipc().editLast(lastUser.content);
    }
  }, [state.messages]);

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
        if (notices.length > 0) {
          // Dismiss the most recent notice
          dismissNotice(notices[notices.length - 1].id);
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
          currentFolder={state.session?.projectDir ?? null}
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
        </header>

        <div className="chat-scroll-area" ref={messagesScrollRef} onScroll={onScroll}>
          <div className="chat-center">
            <div className="messages">
              {isEmpty ? (
                <EmptyState
                  hasSession={!!state.session}
                  onPick={(prompt) => {
                    setComposerPrefill(prompt);
                  }}
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
        {state.session && state.tasksEnabled && state.tasks.length > 0 && (
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
            <Composer busy={state.busy} onSend={sendMessage} />
          </div>
        )}
      </main>

      {showSettings && settingsData && (
        <SettingsModal
          values={settingsData.values}
          hasApiKey={settingsData.hasApiKey}
          mustConfigure={settingsData.mustConfigure}
          onClose={() => {
            setShowSettings(false);
            setSettingsData(null);
          }}
        />
      )}
    </div>
  );
}
