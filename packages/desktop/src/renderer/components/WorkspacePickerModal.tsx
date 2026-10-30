import { memo, useRef, useState } from "react";
import { ipc } from "../ipc.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { FolderIcon } from "./icons.js";

interface WorkspacePickerModalProps {
  onClose: () => void;
  onPicked: (folder: string) => void;
}

export const WorkspacePickerModal = memo(function WorkspacePickerModal({ onClose, onPicked }: WorkspacePickerModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [picking, setPicking] = useState(false);
  useDialogFocus(dialogRef, onClose);

  const pickFolder = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const folder = await ipc().pickFolder();
      if (folder) onPicked(folder);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div ref={dialogRef} className="modal workspace-picker-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-picker-title">
        <div className="workspace-picker-icon" aria-hidden="true"><FolderIcon size={24} /></div>
        <div className="workspace-picker-body">
          <div id="workspace-picker-title" className="workspace-picker-title">Pick a workspace first</div>
          <p className="workspace-picker-copy">Choose the project folder to use for this new session.</p>
        </div>
        <div className="workspace-picker-actions">
          <button type="button" className="workspace-picker-cancel" onClick={onClose} disabled={picking}>Cancel</button>
          <button type="button" className="workspace-picker-submit" onClick={() => void pickFolder()} disabled={picking}>
            <FolderIcon size={14} />
            {picking ? "Opening…" : "Pick folder"}
          </button>
        </div>
      </div>
    </div>
  );
});
