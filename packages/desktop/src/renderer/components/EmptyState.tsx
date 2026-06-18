// Welcome screen. Two variants:
// - No active session (e.g. after delete): invites the user to start a new chat.
// - Active session but no messages yet: brand icon + quick action chips.

import { memo } from "react";
import { BrandIcon, NewChatIcon } from "./icons.js";

interface EmptyStateProps {
  hasSession: boolean;
  onPick: (prompt: string) => void;
  onNewChat: () => void;
}

const QUICK_ACTIONS = [
  "Explain what this codebase does and its main entry points",
  "Review the current file for bugs and suggest improvements",
  "Refactor my code for readability",
];

export const EmptyState = memo(function EmptyState({
  hasSession,
  onPick,
  onNewChat,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <BrandIcon size={26} />
      </div>
      {hasSession ? (
        <>
          <div className="empty-title">How can I help?</div>
          <div className="empty-copy">
            Ask for code edits, file inspection, shell commands, or database queries.
          </div>
          <div className="empty-actions">
            {QUICK_ACTIONS.map((prompt) => (
              <button key={prompt} className="empty-chip" onClick={() => onPick(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="empty-title">Welcome to Siberflow</div>
          <div className="empty-copy">
            Start a new chat to begin. Pick a project folder and ask away.
          </div>
          <div className="empty-actions">
            <button className="empty-chip primary" onClick={onNewChat}>
              <NewChatIcon size={13} /> New chat
            </button>
          </div>
        </>
      )}
    </div>
  );
});
