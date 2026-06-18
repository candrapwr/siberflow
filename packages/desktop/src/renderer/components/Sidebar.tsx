// Left sidebar: session list grouped by folder, new-chat, settings.
// Session names are auto-generated from the first prompt and editable inline
// (double-click the name, or click the edit button).

import { memo, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@shared/protocol";
import { BrandIcon, NewChatIcon, SettingsIcon, TrashIcon, EditIcon } from "./icons.js";

interface SidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

export const Sidebar = memo(function Sidebar({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onNewChat,
  onOpenSettings,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when editing starts.
  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  // Group sessions by projectDir so each folder is a labeled section.
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const arr = groups.get(s.projectDir) ?? [];
    arr.push(s);
    groups.set(s.projectDir, arr);
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

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <BrandIcon size={18} />
          Siberflow
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
        {sessions.length === 0 && (
          <div style={{ padding: "12px 8px", color: "var(--fg-subtle)", fontSize: 11 }}>
            No sessions yet. Click + to start.
          </div>
        )}
        {[...groups.entries()].map(([folder, list]) => (
          <div key={folder}>
            <div className="session-folder-label" title={folder}>
              {shortenPath(folder)}
            </div>
            {list.map((s) => (
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
                  <span
                    className="session-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startEdit(s);
                    }}
                  >
                    {s.name ?? `Chat ${s.id.slice(0, 8)}`}
                  </span>
                )}
                <div className="session-actions">
                  {editingId !== s.id && (
                    <button
                      className="icon-btn session-edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(s);
                      }}
                      title="Rename"
                    >
                      <EditIcon size={11} />
                    </button>
                  )}
                  <button
                    className="icon-btn session-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.id);
                    }}
                    title="Delete"
                  >
                    <TrashIcon size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
});

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}
