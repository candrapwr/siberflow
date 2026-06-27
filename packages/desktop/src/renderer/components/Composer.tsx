// Chat input: textarea + send/stop button. Enter to send, Shift+Enter newline.
// Also hosts the Excel (.xlsx) attachment picker: a paperclip button opens a
// native file dialog, chosen files are copied into the project sandbox by the
// main process, and the resulting relative paths are folded into the outgoing
// prompt so the agent picks them up via `excel_script`.

import { memo, useEffect, useRef, useState } from "react";
import { ipc } from "../ipc.js";
import type { PickedFile } from "@shared/protocol";
import { FileExcelIcon, PaperclipIcon, SendIcon, StopIcon, XIcon } from "./icons.js";

interface ComposerProps {
  busy: boolean;
  onSend: (content: string) => void;
  /** When this value changes and we're not busy, refocus the input.
   * Pass e.g. `${sessionId}:${busy}` to refocus on session switch and after
   * a turn completes. */
  autoFocusKey?: string;
  /** When this changes to a non-empty string, prefill the input with it and
   * focus/select-all so the user can edit then resend. */
  prefill?: string;
  /** Whether the active session has a working directory. Upload is disabled
   * (and attachments cleared) when false, since there's no sandbox to copy
   * files into and `excel_script` wouldn't be registered anyway. */
  hasWorkdir?: boolean;
  /** Whether excel_script is enabled in settings. The upload button is disabled
   * (with a tooltip hint) when false, since uploaded files can't be read. */
  excelEnabled?: boolean;
}

export const Composer = memo(function Composer({ busy, onSend, autoFocusKey, prefill, hasWorkdir = true, excelEnabled = true }: ComposerProps) {
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

  const onPickExcel = async () => {
    if (busy || uploading || !hasWorkdir) return;
    setUploading(true);
    try {
      const result = await ipc().pickExcelFiles();
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

  const uploadDisabled = busy || uploading || !hasWorkdir || !excelEnabled;
  const uploadTitle = !hasWorkdir
    ? "Pilih folder project dulu sebelum upload"
    : !excelEnabled
      ? "Aktifkan excel_script di Tools settings untuk upload Excel"
      : uploading
        ? "Menyalin file…"
        : "Upload file Excel (.xlsx)";

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((f, i) => (
            <span className="attach-chip" key={`${f.relPath}:${i}`} title={f.relPath}>
              <FileExcelIcon size={13} className="attach-chip-icon" />
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
          ))}
        </div>
      )}
      <div className="composer-shell">
        <button
          type="button"
          className="upload-btn"
          onClick={onPickExcel}
          disabled={uploadDisabled}
          title={uploadTitle}
          aria-label="Upload file Excel"
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
      <div className="composer-hint">
        <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>Cmd+K</kbd> focus
      </div>
    </div>
  );
});

/**
 * Compose the user's typed instruction with any attached Excel files into a
 * single prompt string. The attachment block lists each file's relative path
   * and instructs the agent to read them via `excel_script`. If the user typed
 * nothing, a sensible default instruction is supplied so the turn isn't blank.
 *
 * Kept in sync with the VSCode webview's equivalent helper.
 */
export function buildPromptWithAttachments(text: string, files: PickedFile[]): string {
  if (files.length === 0) return text;
  const fileList = files.map((f) => `- ${f.relPath}`).join("\n");
  const instruction = text.length > 0 ? text : "Baca file Excel ini dengan excel_script lalu analisa dan rangkum isinya.";
  return `Saya upload file Excel berikut, sudah tersimpan di folder project:\n${fileList}\n\nTolong baca dengan tool excel_script lalu: ${instruction}`;
}
