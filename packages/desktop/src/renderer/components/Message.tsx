// Renders a single message bubble. Assistant turns render an ordered list of
// text + tool content blocks in the exact order they streamed.

import { memo, useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { ipc } from "../ipc.js";
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
import type { AssistantTurn, ContentBlock, ToolCall } from "../hooks/useChat.js";
import {
  BrandIcon,
  RefreshIcon,
  EditIcon,
  ToolIcon,
  ChevronDownIcon,
} from "./icons.js";

// ─── Tool-call grouping (parallel batches) ──────────────────────────────────

/**
 * A render-ready view of an assistant turn's content blocks where runs of 2+
 * consecutive tool calls are folded into a single `tool-group` node (rendered
 * as one collapsible card). Single tool calls stay as `tool`. Text passes
 * through unchanged. Hidden tools (`__hidden__`) are excluded upstream.
 */
type RenderableBlock =
  | { kind: "text"; id: number; text: string }
  | { kind: "tool"; id: number; tool: ToolCall }
  | { kind: "tool-group"; key: string; tools: { id: number; tool: ToolCall }[] };

/**
 * Group consecutive `kind:"tool"` blocks (length ≥ 2) into `tool-group` nodes.
 * Single tool blocks pass through as `tool`. Pure function over the input list.
 */
function groupBlocks(blocks: readonly ContentBlock[]): RenderableBlock[] {
  const out: RenderableBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const blk = blocks[i]!;
    if (blk.kind !== "tool") {
      out.push(blk);
      i++;
      continue;
    }
    // Collect a maximal run of consecutive tool blocks.
    const run: { id: number; tool: ToolCall }[] = [];
    while (i < blocks.length && blocks[i]!.kind === "tool") {
      const t = blocks[i] as Extract<ContentBlock, { kind: "tool" }>;
      run.push({ id: t.id, tool: t.tool });
      i++;
    }
    if (run.length >= 2) {
      out.push({ kind: "tool-group", key: `g-${run[0]!.id}`, tools: run });
    } else {
      out.push({ kind: "tool", id: run[0]!.id, tool: run[0]!.tool });
    }
  }
  return out;
}

/**
 * Summarize a list of tool names for the group card header. Shows up to 3
 * unique names then "+N" for the rest. E.g. [read, read, exec, write] →
 * "read_file, exec, write_file".
 */
function summarizeToolNames(names: readonly string[]): string {
  const seen: string[] = [];
  for (const n of names) {
    if (!seen.includes(n)) seen.push(n);
    if (seen.length >= 3) break;
  }
  const rest = names.length - seen.length;
  return rest > 0 ? `${seen.join(", ")} +${rest}` : seen.join(", ");
}

interface ToolGroupCardProps {
  tools: { id: number; tool: ToolCall }[];
  compact: boolean;
}

/**
 * A collapsible card summarizing a batch of parallel tool calls. Default
 * collapsed (one-line summary); click the head to expand and see individual
 * ToolBlocks nested inside. Status is computed from children: "running" while
 * any child has no result, "done" once all complete, with an N/total counter.
 */
function ToolGroupCard({ tools, compact }: ToolGroupCardProps) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => t.tool.result === null);
  const doneCount = tools.filter((t) => t.tool.result !== null).length;
  const total = tools.length;
  const names = tools.map((t) => t.tool.name);

  return (
    <div className={`tool-group ${running ? "running" : ""}`}>
      <button
        type="button"
        className="tool-group-head"
        onClick={() => !compact && setOpen((v) => !v)}
        aria-expanded={!compact && open}
        disabled={compact}
      >
        {!compact && (
          <ChevronDownIcon size={10} className={open ? "" : "rotated"} />
        )}
        <ToolIcon size={11} />
        <span className="tool-group-count">{total} tool calls</span>
        <span className="tool-group-names">{summarizeToolNames(names)}</span>
        <span className="tool-group-status">
          {running ? (
            <>
              <span className="tool-group-progress">
                {doneCount}/{total}
              </span>
              <span className="thinking-dots">
                <span />
                <span />
                <span />
              </span>
            </>
          ) : (
            <span className="tool-done">done</span>
          )}
        </span>
      </button>
      {!compact && open && (
        <div className="tool-group-body">
          {tools.map((t) => (
            <ToolBlock
              key={t.id}
              name={t.tool.name}
              args={t.tool.args}
              result={t.tool.result}
              compact={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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
      () => { },
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

interface ParsedUserContent {
  text: string;
  images: string[];
  files: string[];
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function visibleToolArgs(name: string, args: string): string {
  if (name !== "analyze_image") return args;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (typeof parsed.image === "string") {
      parsed.image = "<attached image>";
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Keep malformed tool arguments visible for diagnostics.
  }
  return args;
}

/** Hide internal attachment paths while keeping their semantic sections. */
function parseUserContent(content: string): ParsedUserContent {
  if (!content.includes("Attached files:\n") && !content.includes("Attached images (use analyze_image):\n")) {
    return { text: content, images: [], files: [] };
  }

  const images: string[] = [];
  const files: string[] = [];
  const visible: string[] = [];
  let section: "images" | "files" | null = null;
  for (const line of content.split("\n")) {
    if (line === "Attached images (use analyze_image):") {
      section = "images";
      continue;
    }
    if (line === "Attached files:") {
      section = "files";
      continue;
    }
    if (section && line.startsWith("- ")) {
      const path = line.slice(2).trim();
      if (path) (section === "images" ? images : files).push(path);
      continue;
    }
    if (section && line.trim() === "") {
      section = null;
      continue;
    }
    section = null;
    visible.push(line);
  }

  return { text: visible.join("\n").trim(), images, files };
}

const ImageAttachment = memo(function ImageAttachment({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    void ipc().getImagePreview(path).then((preview) => {
      if (!cancelled) setSrc(preview);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!src) {
    return <div className="user-image-attachment unavailable">Gambar tidak tersedia</div>;
  }
  return <img className="user-image-attachment" src={src} alt={fileName(path)} />;
});

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  const parsed = parseUserContent(content);
  return (
    <div className="msg user">
      <div className="role-label">
        <span className="dot" />
        You
      </div>
      <div className="body">
        {(parsed.images.length > 0 || parsed.files.length > 0) && (
          <div className="user-attachments">
            {parsed.images.map((path) => <ImageAttachment key={path} path={path} />)}
            {parsed.files.map((path) => (
              <div className="user-file-attachment" key={path} title={fileName(path)}>
                {fileName(path)}
              </div>
            ))}
          </div>
        )}
        {parsed.text && <div className="user-message-text">{parsed.text}</div>}
      </div>
    </div>
  );
});

// ─── Assistant Message ──────────────────────────────────────────────────────

interface AssistantMessageProps {
  turn: AssistantTurn;
  hideTools: boolean;
  waitingForAssistant?: boolean;
  activity?: { kind: "thinking" | "tool" | "task" | "subagent" | "context"; label: string; detail?: string } | null;
  showActions: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
}

export const AssistantMessage = memo(function AssistantMessage({
  turn,
  hideTools,
  waitingForAssistant = false,
  activity = null,
  showActions,
  onRegenerate,
  onEdit,
}: AssistantMessageProps) {
  const [showWork, setShowWork] = useState(false);
  const visibleBlocks = turn.blocks.filter(
    (b) => !(b.kind === "tool" && b.tool.name === "__hidden__"),
  );
  const renderable = groupBlocks(visibleBlocks);
  // For restored history, the last text block is the final answer. Everything
  // before it is the turn's work: intermediate assistant content plus tools.
  // Keeping those blocks together preserves the real iteration order when the
  // user expands "Show work".
  const finalText = turn.historical
    ? [...renderable].reverse().find((blk) => blk.kind === "text")
    : undefined;
  const workBlocks = turn.historical && finalText
    ? renderable.filter((blk) => blk !== finalText)
    : turn.historical
      ? renderable
      : [];
  const toolCount = visibleBlocks.filter((blk) => blk.kind === "tool").length;
  const isEmpty = visibleBlocks.length === 0;

  const renderBlock = (blk: RenderableBlock) => {
    if (blk.kind === "text") {
      return (
        <div className="seg" key={blk.id}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {blk.text}
          </ReactMarkdown>
        </div>
      );
    }
    if (blk.kind === "tool-group") {
      return <ToolGroupCard key={blk.key} tools={blk.tools} compact={hideTools} />;
    }
    return <ToolBlock key={blk.id} name={blk.tool.name} args={blk.tool.args} result={blk.tool.result} compact={hideTools} />;
  };

  return (
    <div className="msg assistant">
      <div className="role-label">
        <span className="assistant-avatar"><BrandIcon size={17} /></span>
        Siberflow
      </div>
      <div className="body">
        {turn.historical ? (
          <>
            {workBlocks.length > 0 && (
              <button
                type="button"
                className="work-toggle"
                onClick={() => setShowWork((value) => !value)}
                aria-expanded={showWork}
              >
                <ChevronDownIcon size={10} className={showWork ? "" : "rotated"} />
                {showWork
                  ? "Hide work"
                  : toolCount > 0
                    ? `Show work · ${toolCount} tool call${toolCount === 1 ? "" : "s"}`
                    : "Show earlier work"}
              </button>
            )}
            {showWork && workBlocks.length > 0 && (
              <div className="historical-work">
                {workBlocks.map(renderBlock)}
              </div>
            )}
            {finalText && renderBlock(finalText)}
          </>
        ) : (
          renderable.map(renderBlock)
        )}
        {activity && (
          <div className={`activity-status activity-${activity.kind}`} role="status" aria-live="polite">
            <span className="activity-spinner" aria-hidden="true" />
            <span className="activity-copy">
              <strong>{activity.label}</strong>
              {activity.detail && <small>{activity.detail}</small>}
            </span>
            <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>
          </div>
        )}
        {waitingForAssistant && !activity && (
          <div className="iteration-loading" role="status" aria-live="polite">
            <span>Menunggu respons AI</span>
            <span className="thinking-dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
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
      <button type="button" className="tool-head" onClick={() => !compact && setOpen((v) => !v)} aria-expanded={!compact && open} disabled={compact}>
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
      </button>
      {!compact && open && !running && (
        <div className="tool-content">
          {args && <pre>{visibleToolArgs(name, args)}</pre>}
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
