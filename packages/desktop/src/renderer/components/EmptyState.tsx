// Welcome screen shown when there are no messages: brand icon + quick actions.

import { memo } from "react";
import { BrandIcon } from "./icons.js";

interface EmptyStateProps {
  onPick: (prompt: string) => void;
}

const QUICK_ACTIONS = [
  "Explain what this codebase does and its main entry points",
  "Review the current file for bugs and suggest improvements",
  "Refactor my code for readability",
];

export const EmptyState = memo(function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <BrandIcon size={26} />
      </div>
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
    </div>
  );
});
