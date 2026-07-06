// Chat input: textarea + send/stop button. Enter to send, Shift+Enter newline.
// Also hosts the document (.xlsx/.docx/.pdf) attachment picker: a paperclip
// button opens a native file dialog, chosen files are copied into the session
// upload dir by the main process, and the resulting paths are folded into the
// outgoing prompt so the agent reads them via the matching *_script tool.

import { memo, useEffect, useRef, useState } from "react";
import { ipc } from "../ipc.js";
import type { DocKind, PickedFile, UsageInfo } from "@shared/protocol";
import { FileDocIcon, FileExcelIcon, FilePdfIcon, PaperclipIcon, SendIcon, StopIcon, XIcon } from "./icons.js";

interface ComposerProps {
  busy: boolean;
  onSend: (content: string) => void;
  /** When this value changes and we're not busy, refocus the input.
   * Pass e.g. `${sessionId}:${busy}` to refocus on session switch and after
   * a turn completes. */
  autoFocusKey?: string;
  /** When this changes to a non-empty string, prefill the input with it and
   * focus/select-all so the user can immediately edit or resend. */
  prefill?: string;
  /** Whether the active session has a working directory. Upload is disabled
   * (and attachments cleared) when false, since there's no sandbox to copy
   * files into and the *_script tools wouldn't be registered anyway. */
  hasWorkdir?: boolean;
  /** Whether ANY document tool is enabled in settings. The upload button is
   * disabled (with a tooltip hint) when none are, since uploaded files can't
   * be read. */
  docEnabled?: boolean;
  /** Latest token usage for the active session (drives the context bar). */
  usage?: UsageInfo | null;
  /** Compact-mode context window budget, in tokens. */
  contextWindow?: number;
  /** Compact-mode threshold ratio (0..1) at which auto-compact fires. */
  compactThreshold?: number;
  /** Active context-optimize mode; the bar only renders when "compact". */
  optimizeMode?: "drop" | "summary" | "recent" | "compact";
}

/** Compact a token count to a short human label, e.g. 45200 -> "45K", 1200000 -> "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Pick the right chip icon for a document kind. */
function docIcon(kind: DocKind) {
  if (kind === "docx") return FileDocIcon;
  if (kind === "pdf") return FilePdfIcon;
  return FileExcelIcon;
}

export const Composer = memo(function Composer({ busy, onSend, autoFocusKey, prefill, hasWorkdir = true, docEnabled = true, usage = null, contextWindow = 200000, compactThreshold = 0.8, optimizeMode = "compact" }: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PickedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [stopping, setStopping] = useState(false);

  // Prefill the input when `prefill` changes to a non-empty string (Edit flow).
  useEffect(() => {
    if (prefill !== undefined && prefill.length > 0) {
      setValue(prefill);
      // Focus + select-all so the user can immediately edit or replace.
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.select();
        }
      });
    }
  }, [prefill]);

  // Auto-resize textarea to fit content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [value]);

  // Focus the input on mount, on session switch, and after a turn completes.
  useEffect(() => {
    if (busy) return;
    const ta = taRef.current;
    if (ta && document.activeElement !== ta) {
      ta.focus();
      // Place caret at end so typing appends.
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
  }, [autoFocusKey, busy]);

  // Drop attachments when the session loses its workdir — they're no longer
  // reachable and the excel tools aren't registered anymore.
  useEffect(() => {
    if (!hasWorkdir) setAttachments([]);
  }, [hasWorkdir]);

  const onPickDoc = async () => {
    if (busy || uploading || !hasWorkdir) return;
    setUploading(true);
    try {
      const result = await ipc().pickDocFiles();
      if ("error" in result) {
        // Surface as a transient alert; the host already returns a localized
        // message (e.g. "Pilih folder project dulu…").
        window.alert(result.error);
        return;
      }
      if (result.files.length > 0) {
        setAttachments((prev) => [...prev, ...result.files]);
      }
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const send = () => {
    const text = value.trim();
    if (busy) return;
    if (!text && attachments.length === 0) return;
    const composed = buildPromptWithAttachments(text, attachments);
    setValue("");
    setAttachments([]);
    onSend(composed);
  };

  const stop = () => {
    setStopping(true);
    ipc().stop();
  };

  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const uploadDisabled = busy || uploading || !hasWorkdir || !docEnabled;
  const uploadTitle = !hasWorkdir
    ? "Pilih folder project dulu sebelum upload"
    : !docEnabled
      ? "Aktifkan salah satu tool dokumen (excel_script/docx_script/pdf_script) di Tools settings untuk upload"
      : uploading
        ? "Menyalin file…"
        : "Upload file dokumen (.xlsx/.docx/.pdf)";

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((f, i) => {
            const Icon = docIcon(f.kind);
            return (
              <span className="attach-chip" key={`${f.relPath}:${i}`} title={f.relPath}>
                <Icon size={13} className="attach-chip-icon" />
                <span className="attach-chip-name">{f.name}</span>
                <button
                  type="button"
                  className="attach-chip-x"
                  onClick={() => removeAttachment(i)}
                  disabled={busy}
                  title="Hapus"
                >
                  <XIcon size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="composer-shell">
        <button
          type="button"
          className="upload-btn"
          onClick={onPickDoc}
          disabled={uploadDisabled}
          title={uploadTitle}
          aria-label="Upload file dokumen"
        >
          <PaperclipIcon size={15} />
        </button>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? "Generating…" : "Message Siberflow…"}
          disabled={busy}
          rows={1}
        />
        {busy ? (
          <button className="send-btn stop" onClick={stop} title="Stop">
            <StopIcon size={12} />
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!value.trim() && attachments.length === 0} title="Send (Enter)">
            <SendIcon size={13} />
          </button>
        )}
      </div>
      {optimizeMode === "compact" && (() => {
        const used = usage?.last?.promptTokens ?? 0;
        const pct = contextWindow > 0 ? Math.min(100, (used / contextWindow) * 100) : 0;
        const threshPct = Math.min(100, compactThreshold * 100);
        const tone = pct < 50 ? "ok" : pct < threshPct ? "warn" : "danger";
        return (
          <div className="context-bar" title={`Auto-compact triggers at ${threshPct}% (≈ ${fmtTokens(Math.round(contextWindow * compactThreshold))} tokens)`}>
            <div className="context-bar-track">
              <div className={`context-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
              {threshPct < 100 && (
                <div className="context-bar-threshold" style={{ left: `${threshPct}%` }} />
              )}
            </div>
            <span className="context-bar-text">
              {fmtTokens(used)} / {fmtTokens(contextWindow)} · {Math.round(pct)}%
              <span className="context-bar-thresh-label"> · auto-compact @ {Math.round(threshPct)}%</span>
            </span>
          </div>
        );
      })()}
      <div className="composer-hint">
        <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>Cmd+K</kbd> focus
      </div>
    </div>
  );
});

/**
 * Fold staged attachments into the prompt sent to the agent. Short and
 * type-agnostic: just lists the file paths under a one-line header, then the
 * user's typed instruction (or a generic default if they typed nothing). The
 * agent picks the right `*_script` tool itself based on each file's extension.
 *
 * Kept in sync with the VSCode webview's equivalent helper.
 */
export function buildPromptWithAttachments(text: string, files: PickedFile[]): string {
  if (files.length === 0) return text;
  const fileList = files.map((f) => `- ${f.relPath}`).join("\n");
  const instr = text.length > 0 ? text : "Read these files and summarize their contents.";
  return `Attached files:\n${fileList}\n\n${instr}`;
}
