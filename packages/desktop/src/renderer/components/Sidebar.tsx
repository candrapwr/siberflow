// Left sidebar: session list grouped by time (Today/Yesterday/Earlier),
// new-chat & settings in header, current workspace in footer.
// Session names are auto-generated from the first prompt and editable inline
// (double-click the name, or click the edit button).

import { memo, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@shared/protocol";
import {
  BrandIcon,
  NewChatIcon,
  SettingsIcon,
  TrashIcon,
  EditIcon,
  FolderIcon,
  SearchIcon,
  MoreHorizontalIcon,
  ChatIcon,
  ChevronDownIcon,
} from "./icons.js";

interface SidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  currentFolder: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onChangeWorkdir: () => void;
  sessionsLoading: boolean;
  sessionsRefreshing: boolean;
  sessionsError: string | null;
  onRetrySessions: () => void;
  busySessionId: string | null;
  busyAction: "opening" | "deleting" | null;
}

type TimeGroup = "today" | "yesterday" | "earlier";

function groupOf(updatedAt: string): TimeGroup {
  const then = new Date(updatedAt).getTime();
  const now = Date.now();
  const dayMs = 86400000;
  const diff = now - then;
  if (diff < dayMs) return "today";
  if (diff < 2 * dayMs) return "yesterday";
  return "earlier";
}

const GROUP_LABEL: Record<TimeGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};
const GROUP_ORDER: TimeGroup[] = ["today", "yesterday", "earlier"];

/** Relative time like "3h ago", "2d ago". */
function relativeTime(updatedAt: string): string {
  const then = new Date(updatedAt).getTime();
  const now = Date.now();
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const Sidebar = memo(function Sidebar({
  sessions,
  activeId,
  currentFolder,
  onSelect,
  onDelete,
  onRename,
  onNewChat,
  onOpenSettings,
  onChangeWorkdir,
  sessionsLoading,
  sessionsRefreshing,
  sessionsError,
  onRetrySessions,
  busySessionId,
  busyAction,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  // Filter sessions by search query (match name or first few chars of id)
  const filtered = searchQuery.trim()
    ? sessions.filter(
      (s) =>
        (s.name ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.id.toLowerCase().startsWith(searchQuery.toLowerCase()),
    )
    : sessions;

  // Group sessions by relative time, then sort newest-first within each group.
  const buckets: Record<TimeGroup, SessionSummary[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const s of filtered) buckets[groupOf(s.updatedAt)].push(s);
  for (const k of GROUP_ORDER) {
    buckets[k].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const startEdit = (s: SessionSummary) => {
    setEditingId(s.id);
    setDraft(s.name ?? "");
  };

  const commitEdit = () => {
    if (editingId) {
      onRename(editingId, draft);
      setEditingId(null);
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  // Keyboard shortcut: focus search on Cmd+Shift+F, or Escape to clear
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && searchQuery && document.activeElement === searchRef.current) {
        setSearchQuery("");
        searchRef.current?.blur();
      }
      if (e.key === "Escape" && openMenuId) {
        setOpenMenuId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openMenuId, searchQuery]);

  // Close a session menu when clicking anywhere outside that session row.
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && !target.closest(".session-item")) {
        setOpenMenuId(null);
      }
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, []);

  const renderSession = (s: SessionSummary) => {
    const isBusy = busySessionId === s.id;
    const busyLabel = busyAction === "deleting" ? "Deleting…" : "Opening…";

    return (
      <div
        key={s.id}
        className={`session-item ${s.id === activeId ? "active" : ""}${openMenuId === s.id ? " menu-open" : ""}${isBusy ? " busy" : ""}`}
        onClick={() => !isBusy && onSelect(s.id)}
        aria-busy={isBusy}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!isBusy) setOpenMenuId(s.id);
        }}
      >
        {editingId === s.id ? (
          <input
            ref={inputRef}
            className="session-rename-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") cancelEdit();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <ChatIcon size={15} className="session-icon" />
            <button
              className="session-select"
              aria-current={s.id === activeId ? "page" : undefined}
              disabled={isBusy}
              onClick={(e) => { e.stopPropagation(); onSelect(s.id); }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startEdit(s);
              }}
            >
              {s.name ?? `Chat ${s.id.slice(0, 8)}`}
            </button>
            <span className="session-time">{isBusy ? busyLabel : relativeTime(s.updatedAt)}</span>
            <div className="session-actions">
              <button
                className="icon-btn session-more"
                aria-label={`Actions for ${s.name ?? "this chat"}`}
                aria-expanded={openMenuId === s.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isBusy) setOpenMenuId((id) => (id === s.id ? null : s.id));
                }}
                title="Chat actions"
              >
                <MoreHorizontalIcon size={14} />
              </button>
            </div>
            {openMenuId === s.id && (
              <div className="session-context-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenuId(null);
                    startEdit(s);
                  }}
                >
                  <EditIcon size={12} />
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setOpenMenuId(null);
                    onDelete(s.id);
                  }}
                >
                  <TrashIcon size={12} />
                  Delete
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const hasAny = sessions.length > 0;
  const hasFiltered = filtered.length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="brand-mark"><BrandIcon size={22} /></span>
          <span>Siberflow</span>
          <span className="brand-desktop">Desktop</span>
        </div>
      </div>
      <button className="new-chat-btn" onClick={onNewChat} title="New chat (⌘/Ctrl+N)">
        <NewChatIcon size={17} /><span>New conversation</span><span className="shortcut-hint">{navigator.platform.includes("Mac") ? "⌘ N" : "Ctrl N"}</span>
      </button>

      {/* Search / filter bar */}
      {hasAny && (
        <div className="sidebar-search">
          <SearchIcon size={15} className="sidebar-search-icon" />
          <input
            ref={searchRef}
            className="sidebar-search-input"
            type="text"
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="sidebar-search-clear"
              onClick={() => setSearchQuery("")}
              title="Clear"
            >
              &times;
            </button>
          )}
        </div>
      )}

      <div className="sidebar-section-label">Conversations <span>{sessions.length}</span></div>
      <div className="session-list" aria-busy={sessionsLoading || busySessionId !== null}>
        {sessionsLoading && (
          <div className="session-loading" aria-label="Loading chat history">
            <div className="session-loading-title">Loading chats</div>
            <div className="session-skeleton" />
            <div className="session-skeleton short" />
            <div className="session-skeleton" />
          </div>
        )}
        {!sessionsLoading && sessionsError && !hasAny && (
          <div className="session-state session-state-error">
            <div className="session-state-icon">!</div>
            <strong>Couldn’t load your chats</strong>
            <span>{sessionsError}</span>
            <button type="button" onClick={onRetrySessions}>Try again</button>
          </div>
        )}
        {!sessionsLoading && !sessionsError && !hasAny && (
          <div className="session-empty">
            <NewChatIcon size={22} />
            <div>No chats yet</div>
            <div className="session-empty-hint">Your conversations will appear here.</div>
          </div>
        )}
        {!sessionsLoading && sessionsError && hasAny && (
          <div className="session-state session-state-error compact">
            <strong>Chat list needs attention</strong>
            <span>{sessionsError}</span>
            <button type="button" onClick={onRetrySessions}>Retry</button>
          </div>
        )}
        {sessionsRefreshing && !sessionsLoading && (
          <div className="session-refreshing"><span className="session-spinner" /> Updating chats…</div>
        )}
        {!sessionsLoading && !sessionsError && hasAny && !hasFiltered && (
          <div className="session-empty">
            <SearchIcon size={18} />
            <div>No sessions match &ldquo;{searchQuery}&rdquo;</div>
            <div className="session-empty-hint">
              Try a different search term
            </div>
          </div>
        )}
        {!sessionsLoading && !sessionsError && hasAny &&
          hasFiltered &&
          GROUP_ORDER.map((g) =>
            buckets[g].length > 0 ? (
              <div key={g} className="session-group">
                <div className="session-group-label">{GROUP_LABEL[g]}</div>
                {buckets[g].map(renderSession)}
              </div>
            ) : null,
          )}
      </div>

      <div className="sidebar-footer">
        <button className="workspace-card" onClick={onChangeWorkdir} title={currentFolder ?? "Choose a project folder"}>
          <span className="workspace-icon"><FolderIcon size={18} /></span>
          <span className="sidebar-footer-info">
            <span className="sidebar-footer-label">Your workspace</span>
            <span className="sidebar-footer-path">{currentFolder ? basename(currentFolder) : "Choose a folder"}</span>
          </span>
          <ChevronDownIcon size={13} />
        </button>
        <button className="sidebar-settings" onClick={onOpenSettings} title="Settings (⌘/Ctrl+,)">
          <SettingsIcon size={17} /><span>Settings & preferences</span>
        </button>
      </div>
    </aside>
  );
});

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
