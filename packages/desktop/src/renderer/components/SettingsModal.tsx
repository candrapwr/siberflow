// Settings modal: provider selection, API key (safeStorage-backed), agent config.

import { memo, useState } from "react";
import { ipc } from "../ipc.js";
import { DEFAULT_SETTINGS, type SettingsValues } from "@shared/protocol";

/** Tool toggle entries. task_update is excluded — it's gated by the `tasks`
 * checkbox above (the task-checklist feature flag), not a per-tool toggle. */
const TOGGLE_TOOLS = [
  { name: "read_file", label: "read_file", group: "File" },
  { name: "write_file", label: "write_file", group: "File" },
  { name: "edit_file", label: "edit_file", group: "File" },
  { name: "copy_file", label: "copy_file", group: "File" },
  { name: "list_dir", label: "list_dir", group: "File" },
  { name: "exec", label: "exec", group: "Shell" },
  { name: "db_query", label: "db_query", group: "Database" },
  { name: "ssh_exec", label: "ssh_exec", group: "SSH" },
  { name: "sftp", label: "sftp", group: "SSH" },
  { name: "read_excel", label: "read_excel", group: "Excel" },
  { name: "write_excel", label: "write_excel", group: "Excel" },
  { name: "write_excel_script", label: "write_excel_script", group: "Excel" },
  { name: "web_scrape", label: "web_scrape", group: "Web" },
] as const;

interface SettingsModalProps {
  values: SettingsValues;
  hasApiKey: boolean;
  mustConfigure: boolean;
  onClose: () => void;
}

export const SettingsModal = memo(function SettingsModal({
  values,
  hasApiKey,
  mustConfigure,
  onClose,
}: SettingsModalProps) {
  const [form, setForm] = useState<SettingsValues>({ ...DEFAULT_SETTINGS, ...values });
  const [apiKey, setApiKey] = useState("");
  const set = <K extends keyof SettingsValues>(key: K, val: SettingsValues[K]) =>
    setForm((f) => ({ ...f, [key]: val }));
  /** Toggle a tool name in/out of the enabledTools array. */
  const toggleTool = (name: string) =>
    setForm((f) => ({
      ...f,
      enabledTools: f.enabledTools.includes(name)
        ? f.enabledTools.filter((t) => t !== name)
        : [...f.enabledTools, name],
    }));

  const save = () => {
    // null = leave key unchanged; non-empty = update; empty = clear.
    void ipc().saveSettings(form, apiKey.length > 0 ? apiKey : null);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Siberflow settings</h3>
        <div className="modal-subtitle">Configure your provider and agent behavior.</div>
        {mustConfigure && (
          <div className="must-configure">
            An API key is required before you can chat. Fill in the form below.
          </div>
        )}

        <div className="form-section">
          <div className="form-section-title">Provider</div>
          <div className="form-row">
            <label>Provider</label>
            <select value={form.provider} onChange={(e) => set("provider", e.target.value as SettingsValues["provider"])}>
              <option value="deepseek">deepseek</option>
              <option value="gemini">gemini</option>
              <option value="openai">openai (chat completions)</option>
              <option value="openai-responses">openai-responses (/v1/responses)</option>
              <option value="grok">grok (xAI)</option>
              <option value="qwen">qwen (Alibaba)</option>
              <option value="zai">zai (GLM / Z.AI)</option>
              <option value="claude">claude (Anthropic)</option>
            </select>
          </div>
          <div className="form-row">
            <label>API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasApiKey ? "(stored — leave blank to keep)" : "paste your key"}
              autoComplete="off"
            />
            <div className="form-help">Stored encrypted via OS keychain (safeStorage).</div>
          </div>
          <div className="form-row">
            <label>Model override</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="(leave empty for provider default)"
            />
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Agent</div>
          <div className="form-row inline">
            <label>Enable task checklist</label>
            <input type="checkbox" checked={form.tasks} onChange={(e) => set("tasks", e.target.checked)} />
          </div>
          <div className="form-row inline">
            <label>Auto-continue cut-off responses</label>
            <input type="checkbox" checked={form.autoContinue} onChange={(e) => set("autoContinue", e.target.checked)} />
          </div>
          <div className="form-row inline">
            <label>Hide tool call details</label>
            <input type="checkbox" checked={form.hideTools} onChange={(e) => set("hideTools", e.target.checked)} />
          </div>
          <div className="form-row">
            <label>Max iterations per turn</label>
            <input
              type="number"
              min={1}
              max={500}
              value={form.maxIterations}
              onChange={(e) => set("maxIterations", Number(e.target.value))}
            />
          </div>
          <div className="form-row">
            <label>Request delay (ms)</label>
            <input
              type="number"
              min={0}
              max={60000}
              value={form.requestDelayMs}
              onChange={(e) => set("requestDelayMs", Number(e.target.value))}
            />
            <div className="form-help">Jeda sebelum setiap request ke AI (anti rate-limit / block). 0 = tanpa delay. Default 1500 (1.5 detik).</div>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Context optimization</div>
          <div className="form-row inline">
            <label>Context optimization (drop/summary)</label>
            <input type="checkbox" checked={form.contextOptimize} onChange={(e) => set("contextOptimize", e.target.checked)} />
          </div>
          <div className="form-row">
            <label>Context optimize mode</label>
            <select
              value={form.contextOptimizeMode}
              onChange={(e) => set("contextOptimizeMode", e.target.value as "drop" | "summary")}
            >
              <option value="drop">drop</option>
              <option value="summary">summary</option>
            </select>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">
            Tools <span className="form-section-hint">(disabled tools aren't sent to the AI)</span>
          </div>
          <div className="tools-grid">
            {TOGGLE_TOOLS.map((t) => (
              <label key={t.name} className="tool-toggle">
                <input
                  type="checkbox"
                  checked={form.enabledTools.includes(t.name)}
                  onChange={() => toggleTool(t.name)}
                />
                <span className="tool-toggle-name">{t.label}</span>
                <span className="tool-toggle-group">{t.group}</span>
              </label>
            ))}
          </div>
          <div className="form-help">
            Default: file operations only. Enable exec/db/ssh/excel as needed.
            Task checklist (task_update) is controlled by the checkbox above and
            can't be disabled individually.
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Developer</div>
          <div className="form-row inline">
            <label>Debug logging (stderr)</label>
            <input type="checkbox" checked={form.debug} onChange={(e) => set("debug", e.target.checked)} />
          </div>
        </div>

        <div className="modal-actions">
          {!mustConfigure && (
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
          )}
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
});
