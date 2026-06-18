// Renders a single message bubble. Assistant turns render an ordered list of
// text + tool content blocks in the exact order they streamed.

import { memo, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism/index.js";
import type { AssistantTurn } from "../hooks/useChat.js";
import {
  RefreshIcon,
  EditIcon,
  ToolIcon,
  ChevronDownIcon,
  CopyIcon,
  CheckIcon,
} from "./icons.js";

// ─── Code Block with Syntax Highlighting + Copy Button ──────────────────────

interface CodeBlockProps {
  language: string;
  code: string;
}

const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail in some contexts — silently ignore
    }
  }, [code]);

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-lang-label">{language}</span>
        <button
          className={`code-copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title="Copy code"
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        PreTag="pre"
        customStyle={{
          margin: 0,
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
          borderBottomLeftRadius: "var(--radius-sm)",
          borderBottomRightRadius: "var(--radius-sm)",
          fontSize: "0.92em",
          lineHeight: 1.5,
          background: "#181818",
        }}
        codeTagProps={{ style: { fontFamily: "var(--mono)" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});

// ─── Inline helpers used by ReactMarkdown ───────────────────────────────────

/** Components override for ReactMarkdown — adds syntax highlighting to code
 * blocks and a copy button. Inline code is rendered normally. */
const markdownComponents = {
  // For fenced code blocks we output a self-contained <div> tree, so the
  // default <pre> wrapper from react-markdown would double-wrap.  We strip
  // it by rendering only the children (which the `code` renderer provides).
  pre({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
  },
  code({
    className,
    children,
    ...props
  }: {
    className?: string;
    children?: React.ReactNode;
    [key: string]: unknown;
  }) {
    const match = /language-(\w+)/.exec(className || "");
    const code = String(children).replace(/\n$/, "");

    if (match) {
      // Fenced code block with explicit language → highlighted
      return <CodeBlock language={match[1]} code={code} />;
    }

    // Check for multi-line code without language annotation → plain pre+code
    if (code.includes("\n")) {
      return (
        <pre>
          <button
            className="code-copy-btn legacy-copy"
            onClick={() => navigator.clipboard.writeText(code).catch(() => {})}
            title="Copy code"
          >
            <CopyIcon size={11} />
          </button>
          <code className={className}>{children}</code>
        </pre>
      );
    }

    // Inline code
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

// ─── User Message ───────────────────────────────────────────────────────────

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

// ─── Assistant Message ──────────────────────────────────────────────────────

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
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {blk.text}
                </ReactMarkdown>
              </div>
            );
          }
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

// ─── Tool Block ─────────────────────────────────────────────────────────────

interface ToolBlockProps {
  name: string;
  args: string;
  result: string | null;
  compact?: boolean;
}

function ToolBlock({ name, args, result, compact = false }: ToolBlockProps) {
  const [open, setOpen] = useState(false);
  const running = result === null;

  return (
    <div className={`tool-block ${running ? "running" : ""}`}>
      <div className="tool-head" onClick={() => !compact && setOpen((v) => !v)}>
        {!compact && <ChevronDownIcon size={10} className={open ? "" : "rotated"} />}
        <ToolIcon size={11} />
        <span>{name}</span>
        <span className="tool-status">
          {running ? (
            <span className="thinking-dots">
              <span />
              <span />
              <span />
            </span>
          ) : (
            <span className="tool-done">done</span>
          )}
        </span>
      </div>
      {!compact && open && !running && (
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
