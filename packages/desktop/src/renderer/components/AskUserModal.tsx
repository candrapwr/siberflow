// Modal dialog shown when the agent calls the ask_user tool. Renders the
// question, optional predefined choices, an optional free-text input, and a
// Batal/Kirim row at the bottom (Cancel left, Send right).

import { memo, useState } from "react";
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
  const [text, setText] = useState(prompt.defaultChoice ?? "");
  const [done, setDone] = useState(false);

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

  const showChoices = prompt.choices.length > 0;
  const showFreeText = prompt.allowFreeText || !showChoices;
  const canSubmitText = text.trim().length > 0;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal ask-user-modal">
        <div className="ask-user-question">{prompt.question}</div>
        {showChoices && (
          <div className="ask-user-choices">
            {prompt.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                className="ask-user-choice-btn"
                onClick={() => answer(choice)}
              >
                {choice}
              </button>
            ))}
          </div>
        )}
        {showFreeText && (
          <div className="ask-user-freetext">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={prompt.defaultChoice ?? "Ketik jawaban…"}
              rows={2}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && canSubmitText) {
                  e.preventDefault();
                  answer(text.trim());
                }
              }}
            />
          </div>
        )}
        <div className="ask-user-actions">
          <button type="button" className="ask-user-cancel-btn" onClick={cancel}>
            Batal
          </button>
          {showFreeText && (
            <button
              type="button"
              className="ask-user-submit-btn"
              disabled={!canSubmitText}
              onClick={() => answer(text.trim())}
            >
              Kirim
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
