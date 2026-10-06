// Welcome screen. Two variants:
// - No active session (e.g. after delete / startup): invites new chat.
// - Active session but no messages yet: clean welcome with brand identity.

import { memo } from "react";
import { BrandIcon, NewChatIcon, CodeIcon, FileDocIcon, SparkIcon, ArrowUpRightIcon } from "./icons.js";

const SUGGESTIONS = [
  { title: "Build something", detail: "From an idea to a working project", icon: CodeIcon, prompt: "Help me plan and build a project. First, ask me what I want to create." },
  { title: "Make it clear", detail: "Untangle a question or an idea", icon: SparkIcon, prompt: "Help me understand a complex topic. Ask me what I am working on, then explain it step by step." },
  { title: "Work with files", detail: "Read, review, and refine your work", icon: FileDocIcon, prompt: "Help me review files in my workspace. First, ask which files to focus on and what I want to improve." },
];

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
      <div className="empty-hero" aria-hidden="true"><span className="empty-orbit" /><div className="empty-icon"><BrandIcon size={38} /></div><span className="orbit-dot" /></div>
      <div className="empty-eyebrow">A little space for your next big idea</div>
      {hasSession ? (
        <>
          <h1 className="empty-title">Good things start<br />with a <em>conversation.</em></h1>
          <p className="empty-copy">Think it through. Build it out. Make it happen.<br />Your ideas, with a little help from Siberflow.</p>
          <div className="suggestion-grid">
            {SUGGESTIONS.map(({ title, detail, icon: Icon, prompt }) => (
              <button key={title} className="suggestion-card" onClick={() => onPick(prompt)}>
                <span className="suggestion-top"><Icon size={19} /><ArrowUpRightIcon size={14} /></span>
                <strong>{title}</strong><span>{detail}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <h1 className="empty-title">A fresh start.<br /><em>Endless possibilities.</em></h1>
          <p className="empty-copy">A thoughtful companion for your everyday work.<br />Start a conversation and see where it takes you.</p>
          <button className="empty-cta" onClick={onNewChat}>
            <NewChatIcon size={14} />
            <span>Start new chat</span>
          </button>
        </>
      )}
    </div>
  );
});
