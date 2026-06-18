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
  earlier: "Previous 7 days",
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
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
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
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && searchQuery && document.activeElement === searchRef.current) {
        setSearchQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchQuery]);

  const renderSession = (s: SessionSummary) => (
    <div
      key={s.id}
      className={`session-item ${s.id === activeId ? "active" : ""}`}
      onClick={() => onSelect(s.id)}
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
          <span
            className="session-name"
            onDoubleClick={(e) => {
              e.stopPropagation();
              startEdit(s);
            }}
          >
            {s.name ?? `Chat ${s.id.slice(0, 8)}`}
          </span>
          <span className="session-time">{relativeTime(s.updatedAt)}</span>
          <div className="session-actions">
            <button
              className="icon-btn session-edit"
              onClick={(e) => {
                e.stopPropagation();
                startEdit(s);
              }}
              title="Rename"
            >
              <EditIcon size={10} />
            </button>
            <button
              className="icon-btn session-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              title="Delete"
            >
              <TrashIcon size={11} />
            </button>
          </div>
        </>
      )}
    </div>
  );

  const hasAny = sessions.length > 0;
  const hasFiltered = filtered.length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <BrandIcon size={18} />
          <span>Siberflow</span>
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={onNewChat} title="New chat (Cmd+N)">
            <NewChatIcon size={15} />
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="Settings (Cmd+,)">
            <SettingsIcon size={15} />
          </button>
        </div>
      </div>

      {/* Search / filter bar */}
      {hasAny && (
        <div className="sidebar-search">
          <SearchIcon size={12} className="sidebar-search-icon" />
          <input
            ref={searchRef}
            className="sidebar-search-input"
            type="text"
            placeholder="Search sessions…"
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

      <div className="session-list">
        {!hasAny && (
          <div className="session-empty">
            <NewChatIcon size={22} />
            <div>No chats yet</div>
            <div className="session-empty-hint">Click + to start a conversation</div>
          </div>
        )}
        {hasAny && !hasFiltered && (
          <div className="session-empty">
            <SearchIcon size={18} />
            <div>No sessions match &ldquo;{searchQuery}&rdquo;</div>
            <div className="session-empty-hint">
              Try a different search term
            </div>
          </div>
        )}
        {hasAny &&
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
        <FolderIcon size={13} />
        <div className="sidebar-footer-info">
          <div className="sidebar-footer-label">Workspace</div>
          <div className="sidebar-footer-path" title={currentFolder ?? ""}>
            {currentFolder ? basename(currentFolder) : "—"}
          </div>
        </div>
      </div>
    </aside>
  );
});

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
