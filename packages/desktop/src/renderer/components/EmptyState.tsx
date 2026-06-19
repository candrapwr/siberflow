// Welcome screen. Two variants:
// - No active session (e.g. after delete / startup): invites new chat.
// - Active session but no messages yet: clean welcome with brand identity.

import { memo } from "react";
import { BrandIcon, NewChatIcon } from "./icons.js";

interface EmptyStateProps {
  hasSession: boolean;
  onPick: (prompt: string) => void;
  onNewChat: () => void;
}

export const EmptyState = memo(function EmptyState({
  hasSession,
  onPick,
  onNewChat,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-hero">
        <div className="empty-glow" />
        <div className="empty-icon">
          <BrandIcon size={34} />
        </div>
      </div>
      {hasSession ? (
        <>
          <div className="empty-title">How can I help you today?</div>
          <div className="empty-copy">
            Ask anything — code edits, explanations, shell commands, or database queries.
          </div>
        </>
      ) : (
        <>
          <div className="empty-title">Welcome to Siberflow</div>
          <div className="empty-copy">
            Your AI coding companion. Start a new conversation to begin.
          </div>
          <button className="empty-cta" onClick={onNewChat}>
            <NewChatIcon size={14} />
            <span>Start new chat</span>
          </button>
        </>
      )}
    </div>
  );
});
