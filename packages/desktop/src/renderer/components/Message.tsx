// Renders a single message bubble. Assistant turns render an ordered list of
// text + tool content blocks in the exact order they streamed.

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AssistantTurn } from "../hooks/useChat.js";
import { RefreshIcon, EditIcon, ToolIcon, ChevronDownIcon } from "./icons.js";

interface UserMessageProps {
  content: string;
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="msg user">
      <div className="role-label">
        <span className="dot" />
        You
      </div>
      <div className="body">{content}</div>
    </div>
  );
});

interface AssistantMessageProps {
  turn: AssistantTurn;
  hideTools: boolean;
  showActions: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
}

export const AssistantMessage = memo(function AssistantMessage({
  turn,
  hideTools,
  showActions,
  onRegenerate,
  onEdit,
}: AssistantMessageProps) {
  const visibleBlocks = turn.blocks.filter(
    (b) => !(b.kind === "tool" && b.tool.name === "__hidden__"),
  );
  const isEmpty = visibleBlocks.length === 0;

  return (
    <div className="msg assistant">
      <div className="role-label">
        <span className="dot" />
        Siberflow
      </div>
      <div className="body">
        {visibleBlocks.map((blk) => {
          if (blk.kind === "text") {
            return (
              <div className="seg" key={blk.id}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{blk.text}</ReactMarkdown>
              </div>
            );
          }
          // tool block
          // tool block — always render. In hideTools mode, show a compact
          // collapsed header only (no args/result expanded) so the user still
          // sees tool activity, just without the noise.
          return (
            <ToolBlock
              key={blk.id}
              name={blk.tool.name}
              args={blk.tool.args}
              result={blk.tool.result}
              compact={hideTools}
            />
          );
        })}
        {isEmpty && (
          <span className="thinking-dots">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
      {showActions && (
        <div className="actions-bar">
          <button className="action-btn" onClick={onRegenerate} title="Regenerate">
            <RefreshIcon size={11} /> Regenerate
          </button>
          <button className="action-btn" onClick={onEdit} title="Edit last prompt">
            <EditIcon size={11} /> Edit
          </button>
        </div>
      )}
    </div>
  );
});

interface ToolBlockProps {
  name: string;
  args: string;
  result: string | null;
  compact?: boolean;
}

function ToolBlock({ name, args, result, compact = false }: ToolBlockProps) {
  // Compact mode (hideTools): always collapsed, click still toggles detail.
  const [open, setOpen] = useState(false);
  const hasResult = result !== null;
  return (
    <div className="tool-block">
      <div className="tool-head" onClick={() => !compact && setOpen((v) => !v)}>
        {!compact && <ChevronDownIcon size={10} className={open ? "" : "rotated"} />}
        <ToolIcon size={11} />
        <span>{name}</span>
        {compact && (
          <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: 9 }}>
            {hasResult ? "done" : "…"}
          </span>
        )}
      </div>
      {!compact && open && (
        <div className="tool-content">
          {args && <pre>{args}</pre>}
          {result && (
            <div className="tool-result">
              <pre>{result.length > 400 ? result.slice(0, 400) + "…" : result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
