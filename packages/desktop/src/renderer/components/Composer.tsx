// Chat input: textarea + send/stop button. Enter to send, Shift+Enter newline.

import { memo, useEffect, useRef, useState } from "react";
import { ipc } from "../ipc.js";
import { SendIcon, StopIcon } from "./icons.js";

interface ComposerProps {
  busy: boolean;
  onSend: (content: string) => void;
  /** When this value changes and we're not busy, refocus the input.
   * Pass e.g. `${sessionId}:${busy}` to refocus on session switch and after
   * a turn completes. */
  autoFocusKey?: string;
}

export const Composer = memo(function Composer({ busy, onSend, autoFocusKey }: ComposerProps) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [stopping, setStopping] = useState(false);

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

  const send = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue("");
    onSend(text);
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

  return (
    <div className="composer">
      <div className="composer-shell">
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
          <button className="send-btn" onClick={send} disabled={!value.trim()} title="Send (Enter)">
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
