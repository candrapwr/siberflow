// Modal dialog shown when the agent calls the ask_user tool. Renders the
// question, optional predefined choices (numbered list with click-to-select),
// an optional free-text option, and a footer with Batal (left) + Kirim (right).
// Keyboard: Up/Down to navigate choices, Enter to confirm, Esc to cancel.

import { memo, useState, useEffect, useRef } from "react";
import { ipc } from "../ipc.js";

interface AskUserPrompt {
  id: string;
  question: string;
  choices: string[];
  allowFreeText: boolean;
  defaultChoice?: string;
}

interface AskUserModalProps {
  prompt: AskUserPrompt;
  onClose: () => void;
}

export const AskUserModal = memo(function AskUserModal({ prompt, onClose }: AskUserModalProps) {
  // Build the list of selectable items: choices + optional free-text entry.
  const showChoices = prompt.choices.length > 0;
  const showFreeText = prompt.allowFreeText || !showChoices;
  const totalItems = prompt.choices.length + (showFreeText ? 1 : 0);

  // selectedIndex: 0..choices.length-1 = a choice; choices.length = free text.
  const freeTextIndex = showFreeText ? prompt.choices.length : -1;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [text, setText] = useState(prompt.defaultChoice ?? "");
  const [done, setDone] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const answer = async (value: string) => {
    if (done) return;
    setDone(true);
    await ipc().answerUser(prompt.id, "answer", value);
    onClose();
  };
  const cancel = async () => {
    if (done) return;
    setDone(true);
    await ipc().answerUser(prompt.id, "cancel", "");
    onClose();
  };

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, totalItems - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        // If the free-text option is selected and has content, submit the text.
        if (selectedIndex === freeTextIndex) {
          if (text.trim().length > 0) {
            e.preventDefault();
            answer(text.trim());
          }
        } else {
          e.preventDefault();
          answer(prompt.choices[selectedIndex] ?? "");
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, text, totalItems]);

  // Focus the textarea when the free-text option is selected.
  useEffect(() => {
    if (selectedIndex === freeTextIndex) textRef.current?.focus();
  }, [selectedIndex, freeTextIndex]);

  const canSubmit =
    selectedIndex === freeTextIndex ? text.trim().length > 0 : true;

  const submit = () => {
    if (selectedIndex === freeTextIndex) {
      if (text.trim().length > 0) answer(text.trim());
    } else {
      answer(prompt.choices[selectedIndex] ?? "");
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal ask-user-modal">
        <div className="ask-user-header">
          <span className="ask-user-badge">Pertanyaan</span>
        </div>
        <div className="ask-user-body">
          <div className="ask-user-question">{prompt.question}</div>
          <div className="ask-user-list">
            {prompt.choices.map((choice, i) => (
              <button
                key={choice}
                type="button"
                className={`ask-user-item ${selectedIndex === i ? "selected" : ""}`}
                onClick={() => setSelectedIndex(i)}
                onDoubleClick={() => answer(choice)}
              >
                <span className="ask-user-num">{i + 1}</span>
                <span className="ask-user-item-label">{choice}</span>
              </button>
            ))}
            {showFreeText && (
              <button
                type="button"
                className={`ask-user-item ask-user-freetext-item ${selectedIndex === freeTextIndex ? "selected" : ""}`}
                onClick={() => setSelectedIndex(freeTextIndex)}
              >
                <span className="ask-user-num">{prompt.choices.length + 1}</span>
                <span className="ask-user-item-label">Jawaban sendiri</span>
                {selectedIndex === freeTextIndex && (
                  <textarea
                    ref={textRef}
                    className="ask-user-text-input"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={prompt.defaultChoice ?? "Ketik jawaban…"}
                    rows={2}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                )}
              </button>
            )}
          </div>
        </div>
        <div className="ask-user-hint">
          <kbd>↑</kbd><kbd>↓</kbd> pilih · <kbd>Enter</kbd> konfirmasi · <kbd>Esc</kbd> batal
        </div>
        <div className="ask-user-actions">
          <button type="button" className="ask-user-cancel-btn" onClick={cancel}>
            Batal
          </button>
          <button
            type="button"
            className="ask-user-submit-btn"
            disabled={!canSubmit}
            onClick={submit}
          >
            Kirim
          </button>
        </div>
      </div>
    </div>
  );
});
