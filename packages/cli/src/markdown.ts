const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";

const FENCE_WIDTH = 60;

/**
 * Line-buffered markdown → ANSI renderer for streamed output.
 *
 * Feed deltas; receive ANSI-formatted text containing only complete lines.
 * Trailing partial line stays buffered until the next feed() or finish().
 *
 * Supported:
 *   - Fenced code blocks (```lang) with side border
 *   - Headers: # / ## / ### (#### and deeper render as plain ####)
 *   - Unordered list: -, *
 *   - Ordered list: 1. 2.
 *   - Block quote: >
 *   - Inline: `code`, **bold**, ~~strike~~, [text](url)
 */
export class MarkdownStreamer {
  private buffer = "";
  private inCodeBlock = false;
  private codeLanguage = "";

  reset(): void {
    this.buffer = "";
    this.inCodeBlock = false;
    this.codeLanguage = "";
  }

  feed(delta: string): string {
    this.buffer += delta;
    let out = "";
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      out += this.renderLine(line) + "\n";
    }
    return out;
  }

  finish(): string {
    if (this.buffer.length === 0) return "";
    const line = this.buffer;
    this.buffer = "";
    return this.renderLine(line);
  }

  /** Public so the REPL can do raw streaming + reformat-on-newline. */
  renderLine(line: string): string {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (this.inCodeBlock) {
        this.inCodeBlock = false;
        this.codeLanguage = "";
        return GRAY + "└" + "─".repeat(FENCE_WIDTH) + RESET;
      }
      this.inCodeBlock = true;
      this.codeLanguage = trimmed.slice(3).trim();
      const label = this.codeLanguage ? ` ${this.codeLanguage} ` : "";
      const dashes = "─".repeat(Math.max(0, FENCE_WIDTH - label.length - 1));
      return GRAY + "┌─" + label + dashes + RESET;
    }

    if (this.inCodeBlock) {
      return GRAY + "│ " + RESET + line;
    }

    if (/^### /.test(line)) {
      return BOLD + DIM + line.slice(4) + RESET;
    }
    if (/^## /.test(line)) {
      return BOLD + line.slice(3) + RESET;
    }
    if (/^# /.test(line)) {
      return BOLD + CYAN + line.slice(2) + RESET;
    }

    if (line.startsWith("> ")) {
      return DIM + "│ " + RESET + ITALIC + applyInline(line.slice(2)) + RESET;
    }

    const listMatch = /^(\s*)([-*]|\d+\.) (.*)$/.exec(line);
    if (listMatch) {
      const [, indent = "", marker = "", content = ""] = listMatch;
      const bullet =
        marker === "-" || marker === "*"
          ? CYAN + "•" + RESET
          : CYAN + marker + RESET;
      return indent + bullet + " " + applyInline(content);
    }

    return applyInline(line);
  }
}

function applyInline(text: string): string {
  let out = text;
  out = out.replace(/`([^`]+)`/g, `${YELLOW}$1${RESET}`);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${RESET}`);
  out = out.replace(/~~([^~\n]+)~~/g, `${DIM}$1${RESET}`);
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    `${UNDERLINE}$1${RESET} ${DIM}$2${RESET}`,
  );
  return out;
}
