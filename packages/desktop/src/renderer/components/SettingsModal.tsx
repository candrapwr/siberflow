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
  { name: "excel_script", label: "excel_script", group: "Excel" },
  { name: "docx_script", label: "docx_script", group: "Document" },
  { name: "pdf_script", label: "pdf_script", group: "Document" },
  { name: "run_browser", label: "run_browser", group: "Browser" },
  { name: "analyze_image", label: "analyze_image", group: "Image" },
] as const;

const CUSTOM_PROVIDER_DEFAULT = {
  name: "custom",
  baseUrl: "",
  defaultModel: "",
};

interface SettingsModalProps {
  values: SettingsValues;
  hasApiKey: boolean;
  hasMultimodalApiKey: boolean;
  mustConfigure: boolean;
  onClose: () => void;
}

export const SettingsModal = memo(function SettingsModal({
  values,
  hasApiKey,
  hasMultimodalApiKey,
  mustConfigure,
  onClose,
}: SettingsModalProps) {
  const [form, setForm] = useState<SettingsValues>({
    ...DEFAULT_SETTINGS,
    ...values,
    customProvider: {
      ...CUSTOM_PROVIDER_DEFAULT,
      ...(values.customProvider ?? {}),
    },
  });
  const [apiKey, setApiKey] = useState("");
  const [multimodalApiKey, setMultimodalApiKey] = useState("");
  const [error, setError] = useState("");
  const set = <K extends keyof SettingsValues>(key: K, val: SettingsValues[K]) =>
    setForm((f) => ({ ...f, [key]: val }));
  const setCustomProvider = <K extends keyof SettingsValues["customProvider"]>(
    key: K,
    val: SettingsValues["customProvider"][K],
  ) =>
    setForm((f) => ({
      ...f,
      customProvider: { ...f.customProvider, [key]: val },
    }));
  /** Toggle a tool name in/out of the enabledTools array. */
  const toggleTool = (name: string) =>
    setForm((f) => ({
      ...f,
      enabledTools: f.enabledTools.includes(name)
        ? f.enabledTools.filter((t) => t !== name)
        : [...f.enabledTools, name],
    }));

  const save = () => {
    if (form.provider === "custom") {
      if (!form.customProvider.baseUrl.trim() || !form.customProvider.defaultModel.trim()) {
        setError("Custom provider needs a base URL and default model.");
        return;
      }
    }
    // null = leave key unchanged; non-empty = update; empty = clear.
    void ipc().saveSettings(
      {
        ...form,
        customProvider: {
          name: form.customProvider.name.trim() || "custom",
          baseUrl: form.customProvider.baseUrl.trim().replace(/\/+$/, ""),
          defaultModel: form.customProvider.defaultModel.trim(),
        },
        multimodalProvider: {
          baseUrl: form.multimodalProvider.baseUrl.trim().replace(/\/+$/, ""),
          model: form.multimodalProvider.model.trim(),
        },
      },
      apiKey.length > 0 ? apiKey : null,
      multimodalApiKey.length > 0 ? multimodalApiKey : null,
    );
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
              <option value="custom">custom (OpenAI-compatible)</option>
            </select>
          </div>
          {form.provider === "custom" && (
            <>
              <div className="form-row">
                <label>Custom provider name</label>
                <input
                  type="text"
                  value={form.customProvider.name}
                  onChange={(e) => setCustomProvider("name", e.target.value)}
                  placeholder="custom"
                />
              </div>
              <div className="form-row">
                <label>Base URL</label>
                <input
                  type="text"
                  value={form.customProvider.baseUrl}
                  onChange={(e) => setCustomProvider("baseUrl", e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
                <div className="form-help">OpenAI-compatible root URL. Siberflow appends /chat/completions.</div>
              </div>
              <div className="form-row">
                <label>Default model</label>
                <input
                  type="text"
                  value={form.customProvider.defaultModel}
                  onChange={(e) => setCustomProvider("defaultModel", e.target.value)}
                  placeholder="model-name"
                />
              </div>
            </>
          )}
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
          {error && <div className="form-help form-error">{error}</div>}
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
          <div className="form-section-title">Multimodal image analysis</div>
          <div className="form-row">
            <label>Base URL</label>
            <input
              type="text"
              value={form.multimodalProvider.baseUrl}
              onChange={(e) => set("multimodalProvider", { ...form.multimodalProvider, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
            <div className="form-help">OpenAI-compatible root URL. analyze_image appends /chat/completions.</div>
          </div>
          <div className="form-row">
            <label>Model</label>
            <input
              type="text"
              value={form.multimodalProvider.model}
              onChange={(e) => set("multimodalProvider", { ...form.multimodalProvider, model: e.target.value })}
              placeholder="gpt-4o-mini"
            />
          </div>
          <div className="form-row">
            <label>API key</label>
            <input
              type="password"
              value={multimodalApiKey}
              onChange={(e) => setMultimodalApiKey(e.target.value)}
              placeholder={hasMultimodalApiKey ? "(stored — leave blank to keep)" : "paste your key"}
              autoComplete="off"
            />
            <div className="form-help">Used only by analyze_image. Enable analyze_image in Tools.</div>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title">Context optimization</div>
          <div className="form-row inline">
            <label>Context optimization (drop/summary/recent)</label>
            <input type="checkbox" checked={form.contextOptimize} onChange={(e) => set("contextOptimize", e.target.checked)} />
          </div>
          <div className="form-row">
            <label>Context optimize mode</label>
            <select
              value={form.contextOptimizeMode}
              onChange={(e) => set("contextOptimizeMode", e.target.value as "drop" | "summary" | "recent")}
            >
              <option value="drop">drop</option>
              <option value="summary">summary</option>
              <option value="recent">recent</option>
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
