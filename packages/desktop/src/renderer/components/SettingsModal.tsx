// Settings modal: provider selection, API key (safeStorage-backed), agent config.

import { memo, useRef, useState, type ReactNode } from "react";
import { ipc } from "../ipc.js";
import { DEFAULT_SETTINGS, type SettingsValues } from "@shared/protocol";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { SparkIcon, SettingsIcon, ChatIcon, ToolIcon, CodeIcon, XIcon, SunIcon, MoonIcon } from "./icons.js";

/** Tools that can be enabled for the agent. */
const TOGGLE_TOOLS = [
  { name: "read_file", label: "Read files", group: "File" },
  { name: "write_file", label: "Create files", group: "File" },
  { name: "edit_file", label: "Edit files", group: "File" },
  { name: "copy_file", label: "Copy files", group: "File" },
  { name: "list_dir", label: "Browse folders", group: "File" },
  { name: "delete_file", label: "Delete files", group: "File" },
  { name: "grep", label: "Search in files", group: "File" },
  { name: "exec", label: "Run shell commands", group: "Shell" },
  { name: "db_query", label: "Query databases", group: "Database" },
  { name: "ssh_exec", label: "Run SSH commands", group: "SSH" },
  { name: "sftp", label: "Transfer over SFTP", group: "SSH" },
  { name: "excel_script", label: "Work with Excel", group: "Excel" },
  { name: "docx_script", label: "Work with Word", group: "Document" },
  { name: "pdf_script", label: "Read PDFs", group: "Document" },
  { name: "run_browser", label: "Control browser", group: "Browser" },
  { name: "analyze_image", label: "Analyze images", group: "Image" },
  { name: "web_search", label: "Search the web", group: "Search" },
] as const;

const TOOL_GROUPS = ["File", "Shell", "Database", "SSH", "Excel", "Document", "Browser", "Image", "Search"] as const;
const TOOL_GROUP_META: Record<string, { title: string; description: string }> = {
  File: { title: "Files & folders", description: "Read, create, edit, and organize files in the workspace." },
  Shell: { title: "Terminal", description: "Run commands on this computer. Use only if you trust the request." },
  Database: { title: "Databases", description: "Run read-only database queries when database access is configured." },
  SSH: { title: "Remote access", description: "Connect to remote machines and transfer files over SSH/SFTP." },
  Excel: { title: "Spreadsheets", description: "Inspect and update Excel workbooks." },
  Document: { title: "Documents", description: "Create or inspect Word and PDF documents." },
  Browser: { title: "Browser automation", description: "Use your installed browser to visit and interact with websites." },
  Image: { title: "Image understanding", description: "Let the assistant inspect images using the multimodal provider." },
  Search: { title: "Web search", description: "Search the web using your Exa API key." },
};

const SETTINGS_TABS = [
  { id: "provider", label: "AI & providers", description: "Models and connections", icon: SparkIcon },
  { id: "appearance", label: "Appearance", description: "Light or dark theme", icon: MoonIcon },
  { id: "agent", label: "Agent behavior", description: "Make it work your way", icon: SettingsIcon },
  { id: "context", label: "Conversation", description: "Context and memory", icon: ChatIcon },
  { id: "tools", label: "Tools", description: "Your assistant's capabilities", icon: ToolIcon },
  { id: "developer", label: "Developer", description: "Diagnostics and logs", icon: CodeIcon },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

const CUSTOM_PROVIDER_DEFAULT = {
  name: "custom",
  baseUrl: "",
  defaultModel: "",
};

const PROVIDER_LABELS: Record<SettingsValues["provider"], string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
  openai: "OpenAI (Chat Completions)",
  "openai-responses": "OpenAI (Responses API)",
  grok: "Grok (xAI)",
  qwen: "Qwen (Alibaba)",
  zai: "GLM (Z.AI)",
  claude: "Claude (Anthropic)",
  sibergate: "SiberGate",
  custom: "Custom (OpenAI-compatible)",
};

interface SettingsModalProps {
  values: SettingsValues;
  hasApiKey: boolean;
  hasMultimodalApiKey: boolean;
  hasExaApiKey: boolean;
  mustConfigure: boolean;
  onClose: () => void;
}

interface SettingsCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

function SettingsCard({ title, description, children, className = "" }: SettingsCardProps) {
  return (
    <section className={`settings-card${className ? ` ${className}` : ""}`}>
      <div className="settings-card-heading">
        <div className="settings-card-title">{title}</div>
        {description && <div className="settings-card-description">{description}</div>}
      </div>
      {children}
    </section>
  );
}

export const SettingsModal = memo(function SettingsModal({
  values,
  hasApiKey,
  hasMultimodalApiKey,
  hasExaApiKey,
  mustConfigure,
  onClose,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const [activeTab, setActiveTab] = useState<SettingsTab>("provider");
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
  const [exaApiKey, setExaApiKey] = useState("");
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
  const toggleTool = (name: string) =>
    setForm((f) => ({
      ...f,
      enabledTools: f.enabledTools.includes(name)
        ? f.enabledTools.filter((t) => t !== name)
        : [...f.enabledTools, name],
    }));

  const save = async () => {
    if (form.provider === "custom") {
      if (!form.customProvider.baseUrl.trim() || !form.customProvider.defaultModel.trim()) {
        setError("Add a base URL and default model before saving the custom provider.");
        setActiveTab("provider");
        return;
      }
    } else if (!form.model.trim()) {
      setError("Model override wajib diisi sebelum menyimpan provider.");
      setActiveTab("provider");
      return;
    }
    // null = leave key unchanged; non-empty = update; empty = clear.
    try {
      await ipc().saveSettings(
        {
          ...form,
          // The custom provider's default model is authoritative.
          ...(form.provider === "custom" ? { model: "" } : {}),
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
        exaApiKey.length > 0 ? exaApiKey : null,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    }
  };

  const enabledToolCount = form.enabledTools.length;
  const providerName = form.provider === "custom" ? form.customProvider.name || "Custom provider" : PROVIDER_LABELS[form.provider];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <div>
            <div className="settings-eyebrow">Your Siberflow</div>
            <h3 id="settings-title">Make yourself at home.</h3>
            <div className="modal-subtitle">A few preferences to make this workspace yours.</div>
          </div>
          <button className="settings-close" type="button" onClick={onClose} aria-label="Close settings"><XIcon size={16} /></button>
        </header>

        {mustConfigure && (
          <div className="must-configure">
            <strong>One more step before you start</strong>
            <span>Add an API key in AI &amp; providers to begin chatting.</span>
          </div>
        )}

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-nav-item${activeTab === tab.id ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                aria-current={activeTab === tab.id ? "page" : undefined}
              >
                <tab.icon size={16} />
                <span className="settings-nav-copy">
                  <span className="settings-nav-item-title">{tab.label}</span>
                  <span className="settings-nav-item-description">{tab.description}</span>
                </span>
                {tab.id === "tools" && <span className="settings-nav-badge">{enabledToolCount}</span>}
              </button>
            ))}
            <div className="settings-nav-summary">
              <span className="settings-summary-label">Current setup</span>
              <strong>{providerName}</strong>
              <span>{hasApiKey ? "API key saved" : "API key not set"}</span>
            </div>
          </nav>

          <div className="settings-content">
            {activeTab === "provider" && (
              <div className="settings-page">
                <div className="settings-page-heading">
                  <div>
                    <h4>AI &amp; providers</h4>
                    <p>Choose the service that powers the assistant. API keys are stored securely in your OS keychain.</p>
                  </div>
                  <span className={`settings-connection-status ${hasApiKey ? "connected" : "needs-setup"}`}>
                    <span className="settings-status-dot" />
                    {hasApiKey ? "Ready to chat" : "Needs API key"}
                  </span>
                </div>

                <SettingsCard title="Primary AI provider" description="Used for chat, reasoning, and tool calls.">
                  <div className="settings-field">
                    <label htmlFor="settings-provider">Provider</label>
                    <select id="settings-provider" value={form.provider} onChange={(e) => set("provider", e.target.value as SettingsValues["provider"])}>
                      <option value="deepseek">DeepSeek</option>
                      <option value="gemini">Gemini</option>
                      <option value="openai">OpenAI (Chat Completions)</option>
                      <option value="openai-responses">OpenAI (Responses API)</option>
                      <option value="grok">Grok (xAI)</option>
                      <option value="qwen">Qwen (Alibaba)</option>
                      <option value="zai">GLM (Z.AI)</option>
                      <option value="claude">Claude (Anthropic)</option>
                      <option value="sibergate">SiberGate</option>
                      <option value="custom">Custom (OpenAI-compatible)</option>
                    </select>
                    <span className="settings-help">The provider selected here handles your normal conversations.</span>
                  </div>

                  {form.provider === "custom" && (
                    <div className="settings-nested-card">
                      <div className="settings-nested-title">Custom provider details</div>
                      <div className="settings-field">
                        <label htmlFor="custom-provider-name">Display name</label>
                        <input id="custom-provider-name" type="text" value={form.customProvider.name} onChange={(e) => setCustomProvider("name", e.target.value)} placeholder="My AI provider" />
                      </div>
                      <div className="settings-field">
                        <label htmlFor="custom-provider-url">Base URL</label>
                        <input id="custom-provider-url" type="text" value={form.customProvider.baseUrl} onChange={(e) => setCustomProvider("baseUrl", e.target.value)} placeholder="https://api.example.com/v1" />
                        <span className="settings-help">OpenAI-compatible root URL. Siberflow adds <code>/chat/completions</code>.</span>
                      </div>
                      <div className="settings-field">
                        <label htmlFor="custom-provider-model">Default model</label>
                        <input id="custom-provider-model" type="text" value={form.customProvider.defaultModel} onChange={(e) => setCustomProvider("defaultModel", e.target.value)} placeholder="model-name" />
                      </div>
                    </div>
                  )}

                  <div className="settings-field">
                    <div className="settings-field-title-row">
                      <label htmlFor="settings-api-key">API key</label>
                      <span className={`settings-inline-status ${hasApiKey ? "saved" : ""}`}>{hasApiKey ? "Saved securely" : "Required"}</span>
                    </div>
                    <input id="settings-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasApiKey ? "Leave blank to keep the saved key" : "Paste your API key"} autoComplete="off" />
                    <span className="settings-help">Your key is encrypted and stored by the operating system. It is never shown here.</span>
                  </div>

                  {form.provider !== "custom" && (
                    <>
                      <div className="settings-field">
                        <label htmlFor="settings-model">Model override <span className="settings-required">Required</span></label>
                        <input id="settings-model" type="text" value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="Enter the provider model name" required />
                        <span className="settings-help">Required for this provider. Enter the exact model name supported by its API.</span>
                      </div>
                      <div className="settings-field">
                        <label htmlFor="settings-reasoning-effort">Reasoning effort</label>
                        <select
                          id="settings-reasoning-effort"
                          value={form.reasoningEffort}
                          onChange={(e) => set("reasoningEffort", e.target.value as SettingsValues["reasoningEffort"])}
                        >
                          <option value="none">None</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="max">Max</option>
                        </select>
                        <span className="settings-help">Controls reasoning effort when supported by the selected provider.</span>
                      </div>
                    </>
                  )}
                  <div className="settings-field">
                    <label htmlFor="settings-max-tokens">Max output tokens</label>
                    <div className="settings-input-suffix"><input id="settings-max-tokens" type="number" min={1} max={2000000} step={1000} value={form.maxTokens} onChange={(e) => set("maxTokens", Number(e.target.value))} /><span>tokens</span></div>
                    <span className="settings-help">Maximum response length sent to the AI provider. Default: 50,000 tokens.</span>
                  </div>
                  {error && <div className="settings-error">{error}</div>}
                </SettingsCard>

                <SettingsCard title="Image understanding" description="Allow Siberflow to inspect images attached to a conversation.">
                  <div className="settings-field settings-field-grid">
                    <div>
                      <label htmlFor="multimodal-url">Image AI base URL</label>
                      <input id="multimodal-url" type="text" value={form.multimodalProvider.baseUrl} onChange={(e) => set("multimodalProvider", { ...form.multimodalProvider, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
                    </div>
                    <div>
                      <label htmlFor="multimodal-model">Image model</label>
                      <input id="multimodal-model" type="text" value={form.multimodalProvider.model} onChange={(e) => set("multimodalProvider", { ...form.multimodalProvider, model: e.target.value })} placeholder="gpt-4o-mini" />
                    </div>
                  </div>
                  <div className="settings-field">
                    <div className="settings-field-title-row">
                      <label htmlFor="multimodal-api-key">Image AI API key</label>
                      <span className={`settings-inline-status ${hasMultimodalApiKey ? "saved" : ""}`}>{hasMultimodalApiKey ? "Saved securely" : "Not set"}</span>
                    </div>
                    <input id="multimodal-api-key" type="password" value={multimodalApiKey} onChange={(e) => setMultimodalApiKey(e.target.value)} placeholder={hasMultimodalApiKey ? "Leave blank to keep the saved key" : "Paste a key for the image provider"} autoComplete="off" />
                    <span className="settings-help">This key is only used when the <strong>Analyze images</strong> tool is enabled.</span>
                  </div>
                </SettingsCard>

                <SettingsCard title="Web search" description="Connect Exa so the assistant can look up current information online.">
                  <div className="settings-field">
                    <div className="settings-field-title-row">
                      <label htmlFor="exa-api-key">Exa API key</label>
                      <span className={`settings-inline-status ${hasExaApiKey ? "saved" : ""}`}>{hasExaApiKey ? "Saved securely" : "Not set"}</span>
                    </div>
                    <input id="exa-api-key" type="password" value={exaApiKey} onChange={(e) => setExaApiKey(e.target.value)} placeholder={hasExaApiKey ? "Leave blank to keep the saved key" : "Paste your Exa API key"} autoComplete="off" />
                    <span className="settings-help">After saving, enable <strong>Search the web</strong> from the Tools tab.</span>
                  </div>
                </SettingsCard>
              </div>
            )}

            {activeTab === "agent" && (
              <div className="settings-page">
                <div className="settings-page-heading">
                  <div>
                    <h4>Agent behavior</h4>
                    <p>Control how much independence the assistant has while completing a request.</p>
                  </div>
                </div>

                <SettingsCard title="Assistant behavior" description="These options affect every new request.">
                  <label className="settings-switch">
                    <span className="settings-switch-copy"><strong>Continue long responses</strong><small>Automatically continue when the provider stops before the answer is complete.</small></span>
                    <input type="checkbox" checked={form.autoContinue} onChange={(e) => set("autoContinue", e.target.checked)} />
                    <span className="settings-switch-track"><span /></span>
                  </label>
                  <label className="settings-switch">
                    <span className="settings-switch-copy"><strong>Hide technical tool details</strong><small>Keep tool calls collapsed so the conversation is easier to read.</small></span>
                    <input type="checkbox" checked={form.hideTools} onChange={(e) => set("hideTools", e.target.checked)} />
                    <span className="settings-switch-track"><span /></span>
                  </label>
                  <label className="settings-switch">
                    <span className="settings-switch-copy"><strong>Trim oversized tool output</strong><small>Reduce very large file and terminal results before sending them back to the AI.</small></span>
                    <input type="checkbox" checked={form.preTruncate} onChange={(e) => set("preTruncate", e.target.checked)} />
                    <span className="settings-switch-track"><span /></span>
                  </label>
                </SettingsCard>

                <SettingsCard title="Request limits" description="Higher limits can help complex tasks but may use more time or tokens.">
                  <div className="settings-field-grid">
                    <div className="settings-field">
                      <label htmlFor="max-iterations">Max steps per request</label>
                      <input id="max-iterations" type="number" min={1} max={500} value={form.maxIterations} onChange={(e) => set("maxIterations", Number(e.target.value))} />
                      <span className="settings-help">Default: 50</span>
                    </div>
                    <div className="settings-field">
                      <label htmlFor="request-delay">Delay between requests</label>
                      <div className="settings-input-suffix"><input id="request-delay" type="number" min={0} max={60000} value={form.requestDelayMs} onChange={(e) => set("requestDelayMs", Number(e.target.value))} /><span>ms</span></div>
                      <span className="settings-help">Use a delay to avoid rate limits. 0 turns it off.</span>
                    </div>
                  </div>
                </SettingsCard>
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="settings-page">
                <div className="settings-page-heading">
                  <div>
                    <h4>Appearance</h4>
                    <p>Choose the color theme that feels most comfortable for your workspace.</p>
                  </div>
                </div>

                <SettingsCard title="Color theme" description="Your choice is saved and restored the next time Siberflow opens.">
                  <div className="settings-theme-options" role="radiogroup" aria-label="Color theme">
                    <label className={`settings-theme-option${form.theme === "light" ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="desktop-theme"
                        value="light"
                        checked={form.theme === "light"}
                        onChange={() => set("theme", "light")}
                      />
                      <span className="settings-theme-icon light"><SunIcon size={19} /></span>
                      <span className="settings-theme-copy">
                        <strong>Light</strong>
                        <small>Warm paper tones for bright environments.</small>
                      </span>
                      <span className="settings-theme-radio" />
                    </label>
                    <label className={`settings-theme-option${form.theme === "dark" ? " selected" : ""}`}>
                      <input
                        type="radio"
                        name="desktop-theme"
                        value="dark"
                        checked={form.theme === "dark"}
                        onChange={() => set("theme", "dark")}
                      />
                      <span className="settings-theme-icon dark"><MoonIcon size={18} /></span>
                      <span className="settings-theme-copy">
                        <strong>Dark</strong>
                        <small>Low-glare charcoal tones for dim environments.</small>
                      </span>
                      <span className="settings-theme-radio" />
                    </label>
                  </div>
                  <span className="settings-help settings-theme-help">The theme changes after you save these settings.</span>
                </SettingsCard>
              </div>
            )}

            {activeTab === "context" && (
              <div className="settings-page">
                <div className="settings-page-heading">
                  <div>
                    <h4>Conversation &amp; context</h4>
                    <p>Keep long conversations useful by deciding how older messages are handled.</p>
                  </div>
                </div>

                <SettingsCard title="Context optimization" description="Siberflow can reduce older context when a conversation gets large.">
                  <label className="settings-switch">
                    <span className="settings-switch-copy"><strong>Optimize long conversations</strong><small>Automatically manage older messages so the assistant stays within the model's context window.</small></span>
                    <input type="checkbox" checked={form.contextOptimize} onChange={(e) => set("contextOptimize", e.target.checked)} />
                    <span className="settings-switch-track"><span /></span>
                  </label>
                  <div className="settings-field">
                    <label htmlFor="context-mode">Optimization strategy</label>
                    <select id="context-mode" value={form.contextOptimizeMode} onChange={(e) => set("contextOptimizeMode", e.target.value as SettingsValues["contextOptimizeMode"])}>
                      <option value="compact">Compact with an AI summary (recommended)</option>
                      <option value="summary">Keep a short summary</option>
                      <option value="recent">Keep only recent messages</option>
                      <option value="drop">Drop older messages</option>
                    </select>
                    <span className="settings-help">Compact mode preserves the most useful history while using fewer tokens.</span>
                  </div>
                </SettingsCard>

                {form.contextOptimizeMode === "compact" && (
                  <SettingsCard title="Compact mode details" description="These advanced values are only used with the recommended compact strategy.">
                    <div className="settings-field-grid settings-field-grid-three">
                      <div className="settings-field">
                        <label htmlFor="context-window">Context window</label>
                        <div className="settings-input-suffix"><input id="context-window" type="number" min={1000} max={2000000} step={1000} value={form.contextWindow} onChange={(e) => set("contextWindow", Number(e.target.value))} /><span>tokens</span></div>
                      </div>
                      <div className="settings-field">
                        <label htmlFor="compact-threshold">Compact at</label>
                        <div className="settings-input-suffix"><input id="compact-threshold" type="number" min={0.1} max={1} step={0.05} value={form.compactThreshold} onChange={(e) => set("compactThreshold", Number(e.target.value))} /><span>ratio</span></div>
                      </div>
                      <div className="settings-field">
                        <label htmlFor="recent-turns">Recent turns kept</label>
                        <input id="recent-turns" type="number" min={0} max={20} value={form.compactKeepRecent} onChange={(e) => set("compactKeepRecent", Number(e.target.value))} />
                      </div>
                    </div>
                  </SettingsCard>
                )}
              </div>
            )}

            {activeTab === "tools" && (
              <div className="settings-page">
                <div className="settings-page-heading">
                  <div>
                    <h4>Tools &amp; permissions</h4>
                    <p>Choose the actions the assistant may use. Start with safe file tools and enable extra access only when needed.</p>
                  </div>
                  <span className="settings-tool-count">{enabledToolCount} enabled</span>
                </div>

                <div className="settings-tool-groups">
                  {TOOL_GROUPS.map((group) => {
                    const meta = TOOL_GROUP_META[group]!;
                    const groupTools = TOGGLE_TOOLS.filter((tool) => tool.group === group);
                    return (
                      <section className="settings-tool-group" key={group}>
                        <div className="settings-tool-group-heading">
                          <div>
                            <h5>{meta.title}</h5>
                            <p>{meta.description}</p>
                          </div>
                          <span>{groupTools.filter((tool) => form.enabledTools.includes(tool.name)).length}/{groupTools.length}</span>
                        </div>
                        <div className="settings-tool-list">
                          {groupTools.map((tool) => {
                            const exaLocked = tool.name === "web_search" && !hasExaApiKey;
                            const checked = exaLocked ? false : form.enabledTools.includes(tool.name);
                            return (
                              <label key={tool.name} className={`settings-tool-toggle${exaLocked ? " disabled" : ""}`}>
                                <input type="checkbox" checked={checked} disabled={exaLocked} onChange={() => !exaLocked && toggleTool(tool.name)} />
                                <span className="settings-tool-check" />
                                <span className="settings-tool-copy"><strong>{tool.label}</strong><small>{exaLocked ? "Add an Exa API key first" : tool.name}</small></span>
                              </label>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
                <div className="settings-info-callout">Tools are only made available to the assistant when enabled here. You can change these permissions at any time.</div>
              </div>
            )}

            {activeTab === "developer" && (
              <div className="settings-page">
                <div className="settings-page-heading">
                  <div>
                    <h4>Developer options</h4>
                    <p>Diagnostic controls for troubleshooting. Most users can leave these settings unchanged.</p>
                  </div>
                </div>
                <SettingsCard title="Diagnostics" description="Debug output is written to the desktop process stderr, not shown in your chat.">
                  <label className="settings-switch">
                    <span className="settings-switch-copy"><strong>Enable debug logging</strong><small>Include extra technical details in logs when investigating a problem.</small></span>
                    <input type="checkbox" checked={form.debug} onChange={(e) => set("debug", e.target.checked)} />
                    <span className="settings-switch-track"><span /></span>
                  </label>
                </SettingsCard>
                <div className="settings-info-callout">If you are reporting a problem, turn this on, reproduce the issue, then include the relevant log output with your report.</div>
              </div>
            )}
          </div>
        </div>

        <footer className="modal-actions settings-actions">
          <span className="settings-footer-hint">Changes are applied when you save.</span>
          {!mustConfigure && <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>}
          <button className="btn-primary" type="button" onClick={save}>Save settings</button>
        </footer>
      </div>
    </div>
  );
});
