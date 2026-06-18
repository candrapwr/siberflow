// Left sidebar: session list grouped by time (Today/Yesterday/Earlier),
// new-chat & settings in header, current workspace in footer.
// Session names are auto-generated from the first prompt and editable inline
// (double-click the name, or click the edit button).

import { memo, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@shared/protocol";
import { BrandIcon, NewChatIcon, SettingsIcon, TrashIcon, EditIcon, FolderIcon } from "./icons.js";

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  // Group sessions by relative time, then sort newest-first within each group.
  const buckets: Record<TimeGroup, SessionSummary[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const s of sessions) buckets[groupOf(s.updatedAt)].push(s);
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

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <BrandIcon size={18} />
          <span>Siberflow</span>
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={onNewChat} title="New chat">
            <NewChatIcon size={15} />
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="Settings">
            <SettingsIcon size={15} />
          </button>
        </div>
      </div>

      <div className="session-list">
        {!hasAny && (
          <div className="session-empty">
            <NewChatIcon size={22} />
            <div>No chats yet</div>
            <div className="session-empty-hint">Click + to start a conversation</div>
          </div>
        )}
        {hasAny &&
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
