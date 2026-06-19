// Renders a single message bubble. Assistant turns render an ordered list of
// text + tool content blocks in the exact order they streamed.

import { memo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
// prism-react-renderer bundles a limited Prism; load ALL grammars we need
// from prismjs onto the shared global Prism instance so every language is
// consistently available. prismjs grammars have a dependency order (e.g. php
// needs markup-templating, typescript needs javascript needs clike).
import Prism from "prismjs";
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-markup.js";
import "prismjs/components/prism-markup-templating.js";
import "prismjs/components/prism-php.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-ruby.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-csharp.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-swift.js";
import "prismjs/components/prism-kotlin.js";
import "prismjs/components/prism-dart.js";
import "prismjs/components/prism-lua.js";
import "prismjs/components/prism-perl.js";
import "prismjs/components/prism-scala.js";
import "prismjs/components/prism-elixir.js";
import "prismjs/components/prism-haskell.js";
import "prismjs/components/prism-graphql.js";
import "prismjs/components/prism-markdown.js";
import type { AssistantTurn } from "../hooks/useChat.js";
import {
  RefreshIcon,
  EditIcon,
  ToolIcon,
  ChevronDownIcon,
} from "./icons.js";

// ─── Code Block (syntax highlighted) ────────────────────────────────────────

interface CodeBlockProps {
  language: string;
  code: string;
}

/** Syntax-highlighted code block using prism-react-renderer (lightweight,
 * React-native, no dynamic eval). Includes a language badge + copy button. */
const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  // Map common aliases to the language names Prism understands.
  const ALIAS: Record<string, string> = {
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    ts: "typescript",
    js: "javascript",
    py: "python",
    rs: "rust",
    golang: "go",
    yml: "yaml",
    kt: "kotlin",
    kts: "kotlin",
    h: "cpp",
    cs: "csharp",
    rb: "ruby",
  };
  const lang = ALIAS[language] ?? language;

  const copyCode = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };

  return (
    <div className="code-block" data-lang={lang || "text"}>
      <div className="code-block-header">
        <span className="code-block-lang">{language || "text"}</span>
        <button
          className={`code-copy-btn ${copied ? "copied" : ""}`}
          onClick={copyCode}
          title="Copy code"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <Highlight prism={Prism} theme={themes.vsDark} code={code.replace(/\n$/, "")} language={lang || "text"}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={className} style={style}>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (
                <div {...lineProps} key={i}>
                  {line.map((token, key) => {
                    const tokenProps = getTokenProps({ token });
                    return <span {...tokenProps} key={key} />;
                  })}
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
});

// ─── ReactMarkdown component overrides ──────────────────────────────────────

/** Override `pre`/`code` so fenced code blocks get syntax highlighting via
 * CodeBlock. Inline code and multi-line plain code keep the default styling. */
const markdownComponents: ComponentPropsWithoutRef<typeof ReactMarkdown>["components"] = {
  pre({ children }) {
    // react-markdown wraps the fenced <code> in a <pre>; the inner code element
    // already renders the CodeBlock, so strip the outer pre to avoid nesting.
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const text = String(children);
    // Fenced block with explicit language → highlighted
    if (match && match[1]) {
      return <CodeBlock language={match[1]} code={text.replace(/\n$/, "")} />;
    }
    // Multi-line code without language → plain highlighted as text
    if (text.includes("\n")) {
      return <CodeBlock language="" code={text.replace(/\n$/, "")} />;
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
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
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
