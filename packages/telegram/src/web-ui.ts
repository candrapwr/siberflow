/**
 * Inline HTML/CSS/JS for the Telegram bot admin web UI.
 *
 * Dashboard layout with a sidebar menu and content area. Single-page app that
 * fetches the JSON API (token read from ?token= on first load, reused via
 * Authorization: Bearer header) and renders everything client-side.
 *
 * Pages: Sessions (list + detail/workdir/delete), Send Message (modal popup),
 * Workdirs (overview). Kept in a separate module from the server logic.
 */
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Siberflow Telegram — Admin</title>
<style>
  :root {
    --bg: #0f1117;
    --sidebar: #14171f;
    --panel: #181b24;
    --panel-2: #1f2330;
    --border: #2a2f3d;
    --text: #e6e8ee;
    --muted: #8b92a4;
    --accent: #4f9cf9;
    --accent-hover: #6cb0ff;
    --sys: #8b92a4;
    --user: #4f9cf9;
    --assistant: #4ade80;
    --tool: #fbbf24;
    --danger: #f87171;
    --danger-hover: #ef4444;
    --ok: #4ade80;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Sidebar ── */
  .sidebar {
    width: 220px;
    min-width: 220px;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 0;
  }
  .sidebar-head {
    padding: 18px 20px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-head .logo { font-size: 16px; font-weight: 700; }
  .sidebar-head .sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .nav { padding: 12px 10px; flex: 1; overflow-y: auto; }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 7px;
    cursor: pointer;
    color: var(--text);
    font-size: 13px;
    margin-bottom: 3px;
    transition: background 0.15s;
    border: none;
    background: none;
    width: 100%;
    text-align: left;
  }
  .nav-item:hover { background: var(--panel); }
  .nav-item.active { background: var(--accent); color: #fff; }
  .nav-item .icon { font-size: 16px; width: 20px; text-align: center; }
  .sidebar-foot {
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
  }

  /* ── Main content ── */
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .topbar {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 14px 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .topbar h2 { font-size: 16px; font-weight: 600; }
  .topbar .actions { display: flex; gap: 8px; }
  .content { flex: 1; overflow-y: auto; padding: 24px 28px; }
  .page { display: none; }
  .page.active { display: block; }

  /* ── Buttons ── */
  button {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.15s, border-color 0.15s;
    font-family: inherit;
  }
  button:hover { background: var(--border); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.danger { color: var(--danger); }
  button.danger:hover { background: var(--danger); color: #fff; border-color: var(--danger); }
  /* Icon-only action buttons — fixed width so they line up neatly */
  .icon-btn {
    width: 32px; height: 32px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    border-radius: 6px;
  }
  .icon-btn:hover { background: var(--border); }
  .icon-btn.danger:hover { background: var(--danger); color: #fff; }

  /* ── Forms ── */
  input, textarea, select {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 11px;
    font-size: 13px;
    font-family: inherit;
    width: 100%;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { resize: vertical; min-height: 70px; }
  .form-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .form-field { display: flex; flex-direction: column; gap: 5px; }
  .form-field label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  th {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    font-weight: 600;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 1;
  }
  tr:hover td { background: var(--panel); }
  .badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .badge.private { background: #1e3a5f; color: #6cb0ff; }
  .badge.group { background: #3d2f1e; color: #fbbf24; }
  .badge.supergroup { background: #2f1e3d; color: #c084fc; }
  .badge.thread { background: #1e3d2f; color: #4ade80; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  .muted { color: var(--muted); }
  .name-cell strong { display: block; }
  .name-cell .sid { font-size: 11px; color: var(--muted); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .row-actions { display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }

  /* ── Modal ── */
  .overlay {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    padding: 24px;
    overflow: auto;
  }
  .overlay.active { display: flex; align-items: flex-start; justify-content: center; }
  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    max-width: 1000px;
    width: 100%;
    overflow: hidden;
  }
  .modal.sm { max-width: 520px; }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 15px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
    gap: 12px;
  }
  .modal-head h3 { font-size: 15px; word-break: break-all; }
  .modal-body { padding: 20px; max-height: 75vh; overflow: auto; }

  /* ── Message log ── */
  .msg-meta {
    padding: 12px 20px;
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
  }
  .msg-table td { vertical-align: top; }
  .msg-role { white-space: nowrap; font-weight: 600; }
  .msg-content {
    max-width: 560px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    cursor: pointer;
  }
  .msg-content.collapsed {
    max-height: 120px;
    overflow: hidden;
    position: relative;
  }
  .msg-content.collapsed::after {
    content: "";
    position: absolute; bottom: 0; left: 0; right: 0; height: 40px;
    background: linear-gradient(transparent, var(--panel));
    pointer-events: none;
  }
  .role-system { color: var(--sys); }
  .role-user { color: var(--user); }
  .role-assistant { color: var(--assistant); }
  .role-tool { color: var(--tool); }
  .tool-badge {
    display: inline-block;
    background: #3d2f1e;
    color: var(--tool);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    margin-bottom: 4px;
  }
  .tool-args {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow: auto;
    margin-top: 4px;
  }

  /* ── Workdir tree ── */
  .file-tree { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  .file-tree .dir { color: var(--accent); }
  .file-tree .file { color: var(--text); }
  .file-tree .size { color: var(--muted); }
  .file-tree .item { padding: 2px 0; }

  /* ── Misc ── */
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  .section-title {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--panel-2); border: 1px solid var(--border);
    padding: 12px 18px; border-radius: 8px;
    z-index: 200; display: none; max-width: 380px;
    font-size: 13px;
  }
  .toast.show { display: block; }
  .toast.ok { border-color: var(--ok); }
  .toast.err { border-color: var(--danger); }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat-card .val { font-size: 24px; font-weight: 700; }
  .stat-card .lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

  /* ── Toggle switch ── */
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 18px;
    margin-bottom: 20px;
  }
  .toggle-row .label { font-weight: 600; font-size: 14px; }
  .toggle-row .desc { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .toggle {
    position: relative;
    width: 44px; height: 24px;
    background: var(--border);
    border-radius: 12px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .toggle.on { background: var(--accent); }
  .toggle::after {
    content: "";
    position: absolute;
    top: 3px; left: 3px;
    width: 18px; height: 18px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle.on::after { transform: translateX(20px); }

  /* ── Settings form ── */
  .settings-form { max-width: 640px; }
  .settings-form .form-field { margin-bottom: 16px; }
  .settings-form input:disabled, .settings-form select:disabled { opacity: 0.4; cursor: not-allowed; }
  .status-badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
  }
  .status-badge.env { background: #1e3a5f; color: #6cb0ff; }
  .status-badge.override { background: #1e3d2f; color: #4ade80; }

  /* ── Tools panel ── */
  .tools-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .tool-cat {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
  }
  .tool-cat-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    margin-bottom: 10px;
    font-weight: 600;
  }
  .tool-opt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    cursor: pointer;
  }
  .tool-opt input { width: auto; cursor: pointer; }
  .tool-opt .tn { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  .tool-opt .td { color: var(--muted); font-size: 11px; }
  .tool-opt.locked { opacity: 0.5; cursor: not-allowed; }
  .tool-opt.locked input { cursor: not-allowed; }
  .tool-badge-exec {
    display: inline-block;
    background: #3d2f1e;
    color: var(--tool);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    margin-left: 4px;
  }

  /* ── Preset store ── */
  .preset-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .preset-bar select { flex: 1; min-width: 160px; }
  .preset-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
  }
  .preset-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
  }
  .preset-card .pname { font-weight: 600; font-size: 13px; }
  .preset-card .pmeta { font-size: 11px; color: var(--muted); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .preset-card .pbadge {
    display: inline-block;
    background: #1e3d2f;
    color: var(--ok);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    margin-left: 4px;
  }
</style>
</head>
<body>

<!-- Sidebar -->
<aside class="sidebar">
  <div class="sidebar-head">
    <div class="logo">🤖 Siberflow</div>
    <div class="sub">Telegram Admin</div>
  </div>
  <nav class="nav">
    <button class="nav-item active" data-page="sessions" onclick="goPage('sessions')">
      <span class="icon">💬</span> Sessions
    </button>
    <button class="nav-item" data-page="send" onclick="openSendModal()">
      <span class="icon">✉</span> Kirim Pesan
    </button>
    <button class="nav-item" data-page="overview" onclick="goPage('overview')">
      <span class="icon">📊</span> Overview
    </button>
    <button class="nav-item" data-page="settings" onclick="goPage('settings')">
      <span class="icon">⚙</span> AI Settings
    </button>
    <button class="nav-item" data-page="tools" onclick="goPage('tools')">
      <span class="icon">🔧</span> Tools
    </button>
    <button class="nav-item" data-page="imagelog" onclick="goPage('imagelog')">
      <span class="icon">📷</span> Image Log
    </button>
    <button class="nav-item" data-page="agentlog" onclick="goPage('agentlog')">
      <span class="icon">🤖</span> Agent Log
    </button>
  </nav>
  <div class="sidebar-foot">
    <div>v0.1.0</div>
    <button onclick="logout()" style="margin-top:8px;width:100%;font-size:12px">🚪 Logout</button>
  </div>
</aside>

<!-- Main -->
<div class="main">
  <div class="topbar">
    <h2 id="pageTitle">Sessions</h2>
    <div class="actions" id="topActions"></div>
  </div>
  <div class="content">

    <!-- Page: Sessions -->
    <div class="page active" id="page-sessions">
      <div id="sessionsWrap">
        <div class="empty"><span class="spin"></span> Memuat...</div>
      </div>
    </div>

    <!-- Page: Overview -->
    <div class="page" id="page-overview">
      <div class="section-title">Statistik</div>
      <div class="stat-grid" id="statGrid"></div>
      <div class="section-title">Session Terbaru</div>
      <div id="recentWrap"></div>
    </div>

    <!-- Page: AI Settings -->
    <div class="page" id="page-settings">
      <div id="settingsWrap">
        <div class="empty"><span class="spin"></span> Memuat...</div>
      </div>
    </div>

    <!-- Page: Tools -->
    <div class="page" id="page-tools">
      <div id="toolsWrap">
        <div class="empty"><span class="spin"></span> Memuat...</div>
      </div>
    </div>

    <!-- Page: Image Log -->
    <div class="page" id="page-imagelog">
      <div id="imagelogWrap">
        <div class="empty"><span class="spin"></span> Memuat...</div>
      </div>
    </div>

    <!-- Page: Agent Log -->
    <div class="page" id="page-agentlog">
      <div id="agentlogWrap">
        <div class="empty"><span class="spin"></span> Memuat...</div>
      </div>
    </div>

  </div>
</div>

<!-- Modal: Detail / Workdir -->
<div class="overlay" id="overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal">
    <div class="modal-head">
      <h3 id="modalTitle">Detail</h3>
      <button class="icon-btn" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<!-- Modal: Send Message -->
<div class="overlay" id="sendOverlay" onclick="if(event.target===this)closeSendModal()">
  <div class="modal sm">
    <div class="modal-head">
      <h3>✉ Kirim Pesan</h3>
      <button class="icon-btn" onclick="closeSendModal()">✕</button>
    </div>
    <div class="modal-body">
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-row">
          <div class="form-field" style="flex:1">
            <label>Chat ID</label>
            <input id="sendChatId" placeholder="702257984">
          </div>
          <div class="form-field" style="width:140px">
            <label>Thread ID (opsional)</label>
            <input id="sendThreadId" placeholder="-">
          </div>
        </div>
        <div class="form-field">
          <label>Pesan</label>
          <textarea id="sendText" placeholder="Tulis pesan..." style="min-height:120px"></textarea>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="closeSendModal()">Batal</button>
          <button class="primary" onclick="sendMessage()">➤ Kirim Pesan</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// Session token is stored in localStorage after login (the login page sets it).
// If absent, the server served the login page instead of this dashboard.
const TOKEN = localStorage.getItem("admin_session") || "";
const headers = { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };

// If the session became invalid (expired / revoked), kick back to login.
async function api(path, opts) {
  const res = await fetch(path, { headers, ...(opts || {}) });
  if (res.status === 401) {
    localStorage.removeItem("admin_session");
    location.reload();
    throw new Error("Session expired");
  }
  return res.json();
}

async function logout() {
  try { await fetch("/api/logout", { method: "POST", headers }); } catch {}
  localStorage.removeItem("admin_session");
  location.reload();
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const u = ["B","KB","MB","GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}
function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });
}
function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function toast(msg, ok) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show " + (ok ? "ok" : "err");
  setTimeout(() => t.className = "toast", 4000);
}

// ── Navigation ──
function goPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("page-" + name).classList.add("active");
  document.querySelector('.nav-item[data-page="' + name + '"]').classList.add("active");
  const titles = { sessions: "Sessions", overview: "Overview", settings: "AI Settings", tools: "Tools", imagelog: "Image Log", agentlog: "Agent Log" };
  document.getElementById("pageTitle").textContent = titles[name] || name;
  const topActions = document.getElementById("topActions");
  if (name === "sessions") {
    topActions.innerHTML = '<button class="primary" onclick="loadSessions()">⟳ Refresh</button>';
  } else if (name === "overview") {
    topActions.innerHTML = '<button class="primary" onclick="loadOverview()">⟳ Refresh</button>';
    loadOverview();
  } else if (name === "settings") {
    topActions.innerHTML = '';
    loadSettings();
  } else if (name === "tools") {
    topActions.innerHTML = '';
    loadTools();
  } else if (name === "imagelog") {
    topActions.innerHTML = '<button class="primary" onclick="loadImageLog()">⟳ Refresh</button>';
    loadImageLog();
  } else if (name === "agentlog") {
    topActions.innerHTML = '<button class="primary" onclick="loadAgentLog()">⟳ Refresh</button> <button onclick="clearAgentLog()" style="background:#3d1e1e;color:#f87171">🗑 Hapus Semua</button>';
    loadAgentLog();
  } else {
    topActions.innerHTML = '';
  }
}

// ── AI Settings ──
let settingsCache = null;
let mainPresetsCache = [];
let mmPresetsCache = [];
let iePresetsCache = [];
async function loadSettings() {
  const wrap = document.getElementById("settingsWrap");
  wrap.innerHTML = '<div class="empty"><span class="spin"></span> Memuat...</div>';
  try {
    const [settings, igPresets, mainPresets, mmPresets, iePresets] = await Promise.all([
      api("/api/ai-settings"),
      api("/api/image-presets"),
      api("/api/main-presets"),
      api("/api/multimodal-presets"),
      api("/api/image-edit-presets"),
    ]);
    settingsCache = settings;
    igPresetsCache = Array.isArray(igPresets) ? igPresets : [];
    mainPresetsCache = Array.isArray(mainPresets) ? mainPresets : [];
    mmPresetsCache = Array.isArray(mmPresets) ? mmPresets : [];
    iePresetsCache = Array.isArray(iePresets) ? iePresets : [];
    renderSettings();
  } catch (e) {
    wrap.innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  }
}
function renderSettings() {
  const s = settingsCache || {};
  const enabled = s.enabled === true;
  const statusBadge = enabled
    ? '<span class="status-badge override">OVERRIDE AKTIF</span>'
    : '<span class="status-badge env">ENV (default)</span>';
  const disabledAttr = enabled ? '' : 'disabled';
  const apiKeyPlaceholder = s.hasApiKey ? s.apiKey + " (kosongkan untuk tetap)" : "paste your key";
  const html =
    '<div class="settings-form">' +
      '<div class="toggle-row">' +
        '<div><div class="label">Aktifkan Override Provider</div>' +
        '<div class="desc">Saat aktif, config AI diambil dari settingan ini (bukan env). Saat nonaktif, kembali ke env.</div></div>' +
        '<div class="toggle ' + (enabled ? 'on' : '') + '" id="aiToggle" onclick="toggleAi()"></div>' +
      '</div>' +
      '<div style="margin-bottom:20px">Status saat ini: ' + statusBadge +
        (s.updatedAt ? ' · Update: ' + fmtDate(s.updatedAt) : '') + '</div>' +
      // ── Main provider preset store ──
      '<div class="preset-bar">' +
        '<select id="mainPresetSelect"' + (mainPresetsCache.length ? '' : 'disabled') + '>' +
          '<option value="">— Pilih preset —</option>' +
          mainPresetsCache.map(function(p) {
            return '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.customDefaultModel ? ' (' + esc(p.customDefaultModel) + ')' : '') + '</option>';
          }).join('') +
        '</select>' +
        '<button class="small" onclick="loadMainPresetSelected()" ' + (mainPresetsCache.length ? '' : 'disabled') + '>📥 Load</button>' +
        '<button class="small primary" onclick="saveMainPresetPrompt()">💾 Simpan Config</button>' +
      '</div>' +
      (mainPresetsCache.length
        ? '<div class="preset-list">' + mainPresetsCache.map(function(p) {
            return '<div class="preset-card">' +
              '<div><span class="pname">' + esc(p.name) + '</span>' +
                '<span class="pbadge">stored</span><br>' +
                '<span class="pmeta">' + esc(p.customProviderName || 'custom') + ' · ' + esc(p.customDefaultModel || 'default') + ' · key ' + esc(p.apiKey || '(none)') + '</span></div>' +
              '<div style="display:flex;gap:6px">' +
                '<button class="small" onclick="loadMainPreset(\\''+p.id+'\\')">📥 Load</button>' +
                '<button class="small danger" onclick="deleteMainPreset(\\''+p.id+'\\')">🗑</button>' +
              '</div>' +
            '</div>';
          }).join('') + '</div>'
        : '<div class="form-help" style="margin-bottom:16px">Belum ada preset tersimpan. Isi field di bawah lalu klik "Simpan Config" untuk menyimpan.</div>') +
      '<div class="form-field"><label>Provider</label>' +
        '<select id="setProvider" ' + disabledAttr + '>' +
          '<option value="custom"' + (s.provider === 'custom' ? ' selected' : '') + '>custom (OpenAI-compatible)</option>' +
        '</select></div>' +
      '<div class="form-field"><label>Custom Provider Name</label>' +
        '<input type="text" id="setName" value="' + esc(s.customProviderName) + '" placeholder="custom" ' + disabledAttr + '></div>' +
      '<div class="form-field"><label>Base URL</label>' +
        '<input type="text" id="setBaseUrl" value="' + esc(s.baseUrl) + '" placeholder="https://api.example.com/v1" ' + disabledAttr + '>' +
        '<div class="form-help">OpenAI-compatible root URL. Siberflow appends /chat/completions.</div></div>' +
      '<div class="form-field"><label>API Key</label>' +
        '<input type="password" id="setApiKey" value="' + esc(enabled ? s.apiKey : '') + '" placeholder="' + apiKeyPlaceholder + '" ' + disabledAttr + '></div>' +
      '<div class="form-field"><label>Default Model</label>' +
        '<input type="text" id="setModel" value="' + esc(s.customDefaultModel) + '" placeholder="model-name" ' + disabledAttr + '></div>' +
      '<hr style="border:none;border-top:1px solid var(--border);margin:24px 0">' +
      '<div class="section-title" style="margin-bottom:16px">Image Generator Override</div>' +
      (function() {
        const igEnabled = s.imageGenEnabled === true;
        const igStatus = igEnabled
          ? '<span class="status-badge override">OVERRIDE AKTIF</span>'
          : '<span class="status-badge env">ENV (default)</span>';
        const igDisabled = igEnabled ? '' : 'disabled';
        const igKeyPlaceholder = s.hasImageGenApiKey ? s.imageGenApiKey + ' (kosongkan untuk tetap)' : 'paste image gen key';
        // Preset dropdown options built from the cached preset list.
        const presetOpts = (igPresetsCache || []).map(function(p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.provider) + ')</option>';
        }).join('');
        // Saved presets as cards with load/delete buttons.
        const presetCards = (igPresetsCache || []).map(function(p) {
          return '<div class="preset-card">' +
            '<div><span class="pname">' + esc(p.name) + '</span>' +
              '<span class="pbadge">stored</span><br>' +
              '<span class="pmeta">' + esc(p.provider) + ' · ' + esc(p.model || 'default') + ' · key ' + esc(p.apiKey || '(none)') + '</span></div>' +
            '<div style="display:flex;gap:6px">' +
              '<button class="small" onclick="loadPreset(\\''+p.id+'\\')">📥 Load</button>' +
              '<button class="small danger" onclick="deletePreset(\\''+p.id+'\\')">🗑</button>' +
            '</div>' +
          '</div>';
        }).join('');
        return '' +
          '<div class="toggle-row">' +
            '<div><div class="label">Aktifkan Override Image Gen</div>' +
            '<div class="desc">Override config untuk tool image_gen (bukan model utama).</div></div>' +
            '<div class="toggle ' + (igEnabled ? 'on' : '') + '" id="igToggle" onclick="toggleIg()"></div>' +
          '</div>' +
          '<div style="margin-bottom:20px">Status image gen: ' + igStatus + '</div>' +
          // ── Preset store ──
          '<div class="preset-bar">' +
            '<select id="presetSelect"' + ((igPresetsCache||[]).length ? '' : 'disabled') + '>' +
              '<option value="">— Pilih preset —</option>' +
              presetOpts +
            '</select>' +
            '<button class="small" onclick="loadSelectedPreset()" ' + ((igPresetsCache||[]).length ? '' : 'disabled') + '>📥 Load</button>' +
            '<button class="small primary" onclick="savePresetPrompt()">💾 Simpan Config</button>' +
          '</div>' +
          (presetCards ? '<div class="preset-list">' + presetCards + '</div>' : '<div class="form-help" style="margin-bottom:16px">Belum ada preset tersimpan. Isi field di bawah lalu klik "Simpan Config" untuk menyimpan.</div>') +
          '<div class="form-field"><label>Provider</label>' +
            '<select id="setIgProvider" ' + igDisabled + '>' +
              '<option value="openai"' + (s.imageGenProvider === 'openai' ? ' selected' : '') + '>openai (gpt-image)</option>' +
              '<option value="deepinfra"' + (s.imageGenProvider === 'deepinfra' ? ' selected' : '') + '>deepinfra (FLUX)</option>' +
              '<option value="novita"' + (s.imageGenProvider === 'novita' ? ' selected' : '') + '>novita (Seedream)</option>' +
              '<option value="qwen"' + (s.imageGenProvider === 'qwen' ? ' selected' : '') + '>qwen (Wanxiang)</option>' +
              '<option value="grok"' + (s.imageGenProvider === 'grok' ? ' selected' : '') + '>grok (FLUX)</option>' +
            '</select></div>' +
          '<div class="form-field"><label>API Key</label>' +
            '<input type="password" id="setIgApiKey" value="' + esc(igEnabled ? s.imageGenApiKey : '') + '" placeholder="' + igKeyPlaceholder + '" ' + igDisabled + '></div>' +
          '<div class="form-field"><label>Model</label>' +
            '<input type="text" id="setIgModel" value="' + esc(s.imageGenModel) + '" placeholder="(default per provider)" ' + igDisabled + '></div>' +
          '<div class="form-field"><label>Base URL</label>' +
            '<input type="text" id="setIgBaseUrl" value="' + esc(s.imageGenBaseUrl) + '" placeholder="(default per provider)" ' + igDisabled + '></div>';
      })() +
      '<hr style="border:none;border-top:1px solid var(--border);margin:24px 0">' +
      '<div class="section-title" style="margin-bottom:16px">Multimodal Override (analyze_image)</div>' +
      (function() {
        const mmEnabled = s.multimodalEnabled === true;
        const mmStatus = mmEnabled
          ? '<span class="status-badge override">OVERRIDE AKTIF</span>'
          : '<span class="status-badge env">ENV (default)</span>';
        const mmDisabled = mmEnabled ? '' : 'disabled';
        const mmKeyPlaceholder = s.hasMultimodalApiKey ? s.multimodalApiKey + ' (kosongkan untuk tetap)' : 'paste multimodal key';
        const mmPresetOpts = (mmPresetsCache || []).map(function(p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.model ? ' (' + esc(p.model) + ')' : '') + '</option>';
        }).join('');
        const mmPresetCards = (mmPresetsCache || []).map(function(p) {
          return '<div class="preset-card">' +
            '<div><span class="pname">' + esc(p.name) + '</span>' +
              '<span class="pbadge">stored</span><br>' +
              '<span class="pmeta">' + esc(p.model || 'default') + ' · key ' + esc(p.apiKey || '(none)') + '</span></div>' +
            '<div style="display:flex;gap:6px">' +
              '<button class="small" onclick="loadMmPreset(\\''+p.id+'\\')">📥 Load</button>' +
              '<button class="small danger" onclick="deleteMmPreset(\\''+p.id+'\\')">🗑</button>' +
            '</div>' +
          '</div>';
        }).join('');
        return '' +
          '<div class="toggle-row">' +
            '<div><div class="label">Aktifkan Override Multimodal</div>' +
            '<div class="desc">Override config untuk tool analyze_image (OpenAI-compatible multimodal).</div></div>' +
            '<div class="toggle ' + (mmEnabled ? 'on' : '') + '" id="mmToggle" onclick="toggleMm()"></div>' +
          '</div>' +
          '<div style="margin-bottom:20px">Status multimodal: ' + mmStatus + '</div>' +
          '<div class="preset-bar">' +
            '<select id="mmPresetSelect"' + ((mmPresetsCache||[]).length ? '' : 'disabled') + '>' +
              '<option value="">— Pilih preset —</option>' +
              mmPresetOpts +
            '</select>' +
            '<button class="small" onclick="loadMmPresetSelected()" ' + ((mmPresetsCache||[]).length ? '' : 'disabled') + '>📥 Load</button>' +
            '<button class="small primary" onclick="saveMmPresetPrompt()">💾 Simpan Config</button>' +
          '</div>' +
          (mmPresetCards ? '<div class="preset-list">' + mmPresetCards + '</div>' : '<div class="form-help" style="margin-bottom:16px">Belum ada preset tersimpan.</div>') +
          '<div class="form-field"><label>API Key</label>' +
            '<input type="password" id="setMmApiKey" value="' + esc(mmEnabled ? s.multimodalApiKey : '') + '" placeholder="' + mmKeyPlaceholder + '" ' + mmDisabled + '></div>' +
          '<div class="form-field"><label>Model</label>' +
            '<input type="text" id="setMmModel" value="' + esc(s.multimodalModel) + '" placeholder="gpt-4o-mini" ' + mmDisabled + '></div>' +
          '<div class="form-field"><label>Base URL</label>' +
            '<input type="text" id="setMmBaseUrl" value="' + esc(s.multimodalBaseUrl) + '" placeholder="https://api.openai.com/v1" ' + mmDisabled + '></div>';
      })() +
      '<hr style="border:none;border-top:1px solid var(--border);margin:24px 0">' +
      '<div class="section-title" style="margin-bottom:16px">Image Edit Override</div>' +
      (function() {
        const ieEnabled = s.imageEditEnabled === true;
        const ieStatus = ieEnabled
          ? '<span class="status-badge override">OVERRIDE AKTIF</span>'
          : '<span class="status-badge env">FALLBACK (pakai image gen)</span>';
        const ieDisabled = ieEnabled ? '' : 'disabled';
        const ieKeyPlaceholder = s.hasImageEditApiKey ? s.imageEditApiKey + ' (kosongkan untuk tetap)' : 'paste image edit key';
        const iePresetOpts = (iePresetsCache || []).map(function(p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.provider) + ')</option>';
        }).join('');
        const iePresetCards = (iePresetsCache || []).map(function(p) {
          return '<div class="preset-card">' +
            '<div><span class="pname">' + esc(p.name) + '</span>' +
              '<span class="pbadge">stored</span><br>' +
              '<span class="pmeta">' + esc(p.provider) + ' · ' + esc(p.model || 'default') + ' · key ' + esc(p.apiKey || '(none)') + '</span></div>' +
            '<div style="display:flex;gap:6px">' +
              '<button class="small" onclick="loadIePreset(\\''+p.id+'\\')">📥 Load</button>' +
              '<button class="small danger" onclick="deleteIePreset(\\''+p.id+'\\')">🗑</button>' +
            '</div>' +
          '</div>';
        }).join('');
        return '' +
          '<div class="toggle-row">' +
            '<div><div class="label">Aktifkan Override Image Edit</div>' +
            '<div class="desc">Override provider untuk mode EDIT image_gen. Jika nonaktif, edit memakai config image gen.</div></div>' +
            '<div class="toggle ' + (ieEnabled ? 'on' : '') + '" id="ieToggle" onclick="toggleIe()"></div>' +
          '</div>' +
          '<div style="margin-bottom:20px">Status image edit: ' + ieStatus + '</div>' +
          '<div class="preset-bar">' +
            '<select id="iePresetSelect"' + ((iePresetsCache||[]).length ? '' : 'disabled') + '>' +
              '<option value="">— Pilih preset —</option>' +
              iePresetOpts +
            '</select>' +
            '<button class="small" onclick="loadIePresetSelected()" ' + ((iePresetsCache||[]).length ? '' : 'disabled') + '>📥 Load</button>' +
            '<button class="small primary" onclick="saveIePresetPrompt()">💾 Simpan Config</button>' +
          '</div>' +
          (iePresetCards ? '<div class="preset-list">' + iePresetCards + '</div>' : '<div class="form-help" style="margin-bottom:16px">Belum ada preset tersimpan.</div>') +
          '<div class="form-field"><label>Provider</label>' +
            '<select id="setIeProvider" ' + ieDisabled + '>' +
              '<option value="openai"' + (s.imageEditProvider === 'openai' ? ' selected' : '') + '>openai (gpt-image)</option>' +
              '<option value="deepinfra"' + (s.imageEditProvider === 'deepinfra' ? ' selected' : '') + '>deepinfra (FLUX)</option>' +
              '<option value="novita"' + (s.imageEditProvider === 'novita' ? ' selected' : '') + '>novita (Seedream)</option>' +
              '<option value="qwen"' + (s.imageEditProvider === 'qwen' ? ' selected' : '') + '>qwen (Wanxiang)</option>' +
              '<option value="grok"' + (s.imageEditProvider === 'grok' ? ' selected' : '') + '>grok (FLUX)</option>' +
            '</select></div>' +
          '<div class="form-field"><label>API Key</label>' +
            '<input type="password" id="setIeApiKey" value="' + esc(ieEnabled ? s.imageEditApiKey : '') + '" placeholder="' + ieKeyPlaceholder + '" ' + ieDisabled + '></div>' +
          '<div class="form-field"><label>Model</label>' +
            '<input type="text" id="setIeModel" value="' + esc(s.imageEditModel) + '" placeholder="(default per provider)" ' + ieDisabled + '></div>' +
          '<div class="form-field"><label>Base URL</label>' +
            '<input type="text" id="setIeBaseUrl" value="' + esc(s.imageEditBaseUrl) + '" placeholder="(default per provider)" ' + ieDisabled + '></div>';
      })() +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button class="primary" onclick="saveSettings()">💾 Simpan Semua</button>' +
      '</div>' +
    '</div>';
  document.getElementById("settingsWrap").innerHTML = html;
}
function toggleAi() {
  if (!settingsCache) return;
  settingsCache.enabled = !settingsCache.enabled;
  renderSettings();
}
function toggleIg() {
  if (!settingsCache) return;
  settingsCache.imageGenEnabled = !settingsCache.imageGenEnabled;
  renderSettings();
}
function toggleMm() {
  if (!settingsCache) return;
  settingsCache.multimodalEnabled = !settingsCache.multimodalEnabled;
  renderSettings();
}
function toggleIe() {
  if (!settingsCache) return;
  settingsCache.imageEditEnabled = !settingsCache.imageEditEnabled;
  renderSettings();
}

// ── Image gen preset store ──
let igPresetsCache = [];
async function loadPresets() {
  try {
    igPresetsCache = await api("/api/image-presets");
  } catch { igPresetsCache = []; }
}
function loadSelectedPreset() {
  const id = document.getElementById("presetSelect").value;
  if (id) loadPreset(id);
}
async function loadPreset(id) {
  try {
    // Fetch the FULL preset (unmasked API key) from the single-preset endpoint.
    // The list endpoint masks keys for safety, so we can't rely on it for loading.
    const p = await api("/api/image-presets/" + encodeURIComponent(id));
    document.getElementById("setIgProvider").value = p.provider;
    document.getElementById("setIgModel").value = p.model;
    document.getElementById("setIgBaseUrl").value = p.baseUrl;
    document.getElementById("setIgApiKey").value = p.apiKey || "";
    toast("Preset '" + p.name + "' dimuat. Klik Simpan untuk menerapkan.", true);
  } catch (e) {
    toast("Gagal load preset: " + e.message, false);
  }
}
async function savePresetPrompt() {
  const name = prompt("Nama preset:", document.getElementById("setIgProvider").value);
  if (!name) return;
  let apiKey = document.getElementById("setIgApiKey").value;
  // The API key field often holds a MASKED value (****XXXX) loaded from the
  // active settings. Saving a masked key corrupts the preset. If masked (or
  // empty), prompt the user to paste the real key before saving.
  if (!apiKey || apiKey.includes("*")) {
    const input = prompt(
      "API key belum diisi atau masih ter-masked (****).\\n" +
      "Paste API key asli untuk disimpan di preset ini\\n" +
      "(atau klik Cancel untuk menyimpan preset TANPA key):",
      "",
    );
    if (input === null) {
      // User cancelled → save preset without a key (they can add it later).
      apiKey = "";
    } else {
      apiKey = input.trim();
    }
  }
  const body = {
    name: name,
    provider: document.getElementById("setIgProvider").value,
    apiKey: apiKey,
    model: document.getElementById("setIgModel").value,
    baseUrl: document.getElementById("setIgBaseUrl").value,
  };
  try {
    const d = await api("/api/image-presets", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) {
      igPresetsCache = d.presets || [];
      toast("Preset '" + name + "' tersimpan.", true);
      renderSettings();
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}
async function deletePreset(id) {
  const p = igPresetsCache.find(function(x) { return x.id === id; });
  if (!p) return;
  if (!confirm("Hapus preset '" + p.name + "'?")) return;
  try {
    const d = await api("/api/image-presets/" + encodeURIComponent(id), { method: "DELETE" });
    if (d.ok) {
      igPresetsCache = d.presets || [];
      toast("Preset dihapus.", true);
      renderSettings();
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Main provider preset store ──
function loadMainPresetSelected() {
  const id = document.getElementById("mainPresetSelect").value;
  if (id) loadMainPreset(id);
}
async function loadMainPreset(id) {
  try {
    const p = await api("/api/main-presets/" + encodeURIComponent(id));
    document.getElementById("setName").value = p.customProviderName;
    document.getElementById("setBaseUrl").value = p.baseUrl;
    document.getElementById("setModel").value = p.customDefaultModel;
    document.getElementById("setApiKey").value = p.apiKey || "";
    toast("Preset '" + p.name + "' dimuat. Klik Simpan untuk menerapkan.", true);
  } catch (e) {
    toast("Gagal load preset: " + e.message, false);
  }
}
async function saveMainPresetPrompt() {
  const name = prompt("Nama preset:", document.getElementById("setModel").value || "custom-provider");
  if (!name) return;
  let apiKey = document.getElementById("setApiKey").value;
  // Same masked-key guard as the image-gen preset save (see savePresetPrompt).
  if (!apiKey || apiKey.includes("*")) {
    const input = prompt(
      "API key belum diisi atau masih ter-masked (****).\\n" +
      "Paste API key asli untuk disimpan di preset ini\\n" +
      "(atau klik Cancel untuk menyimpan preset TANPA key):",
      "",
    );
    if (input === null) {
      apiKey = "";
    } else {
      apiKey = input.trim();
    }
  }
  const body = {
    name: name,
    customProviderName: document.getElementById("setName").value,
    baseUrl: document.getElementById("setBaseUrl").value,
    apiKey: apiKey,
    customDefaultModel: document.getElementById("setModel").value,
  };
  try {
    const d = await api("/api/main-presets", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) {
      mainPresetsCache = d.presets || [];
      toast("Preset '" + name + "' tersimpan.", true);
      renderSettings();
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}
async function deleteMainPreset(id) {
  const p = mainPresetsCache.find(function(x) { return x.id === id; });
  if (!p) return;
  if (!confirm("Hapus preset '" + p.name + "'?")) return;
  try {
    const d = await api("/api/main-presets/" + encodeURIComponent(id), { method: "DELETE" });
    if (d.ok) {
      mainPresetsCache = d.presets || [];
      toast("Preset dihapus.", true);
      renderSettings();
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Multimodal preset store ──
function loadMmPresetSelected() {
  const id = document.getElementById("mmPresetSelect").value;
  if (id) loadMmPreset(id);
}
async function loadMmPreset(id) {
  try {
    const p = await api("/api/multimodal-presets/" + encodeURIComponent(id));
    document.getElementById("setMmModel").value = p.model;
    document.getElementById("setMmBaseUrl").value = p.baseUrl;
    document.getElementById("setMmApiKey").value = p.apiKey || "";
    toast("Preset '" + p.name + "' dimuat. Klik Simpan untuk menerapkan.", true);
  } catch (e) {
    toast("Gagal load preset: " + e.message, false);
  }
}
async function saveMmPresetPrompt() {
  const name = prompt("Nama preset:", document.getElementById("setMmModel").value || "multimodal");
  if (!name) return;
  let apiKey = document.getElementById("setMmApiKey").value;
  if (!apiKey || apiKey.includes("*")) {
    const input = prompt(
      "API key belum diisi atau masih ter-masked (****).\\n" +
      "Paste API key asli untuk disimpan di preset ini\\n" +
      "(atau klik Cancel untuk menyimpan preset TANPA key):",
      "",
    );
    if (input === null) {
      apiKey = "";
    } else {
      apiKey = input.trim();
    }
  }
  const body = {
    name: name,
    apiKey: apiKey,
    model: document.getElementById("setMmModel").value,
    baseUrl: document.getElementById("setMmBaseUrl").value,
  };
  try {
    const d = await api("/api/multimodal-presets", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) {
      mmPresetsCache = d.presets || [];
      toast("Preset '" + name + "' tersimpan.", true);
      renderSettings();
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}
async function deleteMmPreset(id) {
  const p = mmPresetsCache.find(function(x) { return x.id === id; });
  if (!p) return;
  if (!confirm("Hapus preset '" + p.name + "'?")) return;
  try {
    const d = await api("/api/multimodal-presets/" + encodeURIComponent(id), { method: "DELETE" });
    if (d.ok) {
      mmPresetsCache = d.presets || [];
      toast("Preset dihapus.", true);
      renderSettings();
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Image edit preset store ──
function loadIePresetSelected() {
  const id = document.getElementById("iePresetSelect").value;
  if (id) loadIePreset(id);
}
async function loadIePreset(id) {
  try {
    const p = await api("/api/image-edit-presets/" + encodeURIComponent(id));
    document.getElementById("setIeProvider").value = p.provider;
    document.getElementById("setIeModel").value = p.model;
    document.getElementById("setIeBaseUrl").value = p.baseUrl;
    document.getElementById("setIeApiKey").value = p.apiKey || "";
    toast("Preset '" + p.name + "' dimuat. Klik Simpan untuk menerapkan.", true);
  } catch (e) {
    toast("Gagal load preset: " + e.message, false);
  }
}
async function saveIePresetPrompt() {
  const name = prompt("Nama preset:", document.getElementById("setIeProvider").value);
  if (!name) return;
  let apiKey = document.getElementById("setIeApiKey").value;
  if (!apiKey || apiKey.includes("*")) {
    const input = prompt(
      "API key belum diisi atau masih ter-masked (****).\\n" +
      "Paste API key asli untuk disimpan di preset ini\\n" +
      "(atau klik Cancel untuk menyimpan preset TANPA key):",
      "",
    );
    if (input === null) {
      apiKey = "";
    } else {
      apiKey = input.trim();
    }
  }
  const body = {
    name: name,
    provider: document.getElementById("setIeProvider").value,
    apiKey: apiKey,
    model: document.getElementById("setIeModel").value,
    baseUrl: document.getElementById("setIeBaseUrl").value,
  };
  try {
    const d = await api("/api/image-edit-presets", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) {
      iePresetsCache = d.presets || [];
      toast("Preset '" + name + "' tersimpan.", true);
      renderSettings();
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}
async function deleteIePreset(id) {
  const p = iePresetsCache.find(function(x) { return x.id === id; });
  if (!p) return;
  if (!confirm("Hapus preset '" + p.name + "'?")) return;
  try {
    const d = await api("/api/image-edit-presets/" + encodeURIComponent(id), { method: "DELETE" });
    if (d.ok) {
      iePresetsCache = d.presets || [];
      toast("Preset dihapus.", true);
      renderSettings();
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}
async function saveSettings() {
  const body = {
    enabled: settingsCache.enabled === true,
    provider: document.getElementById("setProvider").value,
    customProviderName: document.getElementById("setName").value,
    baseUrl: document.getElementById("setBaseUrl").value,
    apiKey: document.getElementById("setApiKey").value,
    customDefaultModel: document.getElementById("setModel").value,
    imageGenEnabled: settingsCache.imageGenEnabled === true,
    imageGenProvider: document.getElementById("setIgProvider").value,
    imageGenApiKey: document.getElementById("setIgApiKey").value,
    imageGenModel: document.getElementById("setIgModel").value,
    imageGenBaseUrl: document.getElementById("setIgBaseUrl").value,
    multimodalEnabled: settingsCache.multimodalEnabled === true,
    multimodalApiKey: document.getElementById("setMmApiKey").value,
    multimodalModel: document.getElementById("setMmModel").value,
    multimodalBaseUrl: document.getElementById("setMmBaseUrl").value,
    imageEditEnabled: settingsCache.imageEditEnabled === true,
    imageEditProvider: document.getElementById("setIeProvider").value,
    imageEditApiKey: document.getElementById("setIeApiKey").value,
    imageEditModel: document.getElementById("setIeModel").value,
    imageEditBaseUrl: document.getElementById("setIeBaseUrl").value,
  };
  try {
    const d = await api("/api/ai-settings", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) {
      settingsCache = { ...settingsCache, ...d.settings, enabled: body.enabled, imageGenEnabled: body.imageGenEnabled, multimodalEnabled: body.multimodalEnabled, imageEditEnabled: body.imageEditEnabled };
      toast("Settings tersimpan.", true);
      renderSettings();
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Tools panel ──
let toolsCache = null;
let toolsSelection = new Set();  // currently checked tool names in the UI
async function loadTools() {
  const wrap = document.getElementById("toolsWrap");
  wrap.innerHTML = '<div class="empty"><span class="spin"></span> Memuat...</div>';
  try {
    toolsCache = await api("/api/tools");
    // Initialize the selection to the active set.
    toolsSelection = new Set(toolsCache.active || []);
    renderTools();
  } catch (e) {
    wrap.innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  }
}
function renderTools() {
  const override = toolsCache.toolsOverride === true;
  const statusBadge = override
    ? '<span class="status-badge override">OVERRIDE AKTIF</span>'
    : '<span class="status-badge env">ENV (default)</span>';
  const activeSet = override ? toolsSelection : new Set(toolsCache.env || []);
  // When override is off, checkboxes reflect env state and are disabled.
  const disabledAttr = override ? '' : 'disabled';

  let grid = '';
  for (const cat of toolsCache.catalog) {
    let opts = '';
    for (const t of cat.tools) {
      const checked = activeSet.has(t.name);
      const isExec = t.name === 'exec';
      const execNote = isExec ? '<span class="tool-badge-exec">admin only</span>' : '';
      opts += '<label class="tool-opt' + (override ? '' : ' locked') + '">' +
        '<input type="checkbox" data-tool="' + esc(t.name) + '" ' +
          (checked ? 'checked' : '') + ' ' + disabledAttr +
          (override ? ' onchange="toggleTool(\\''+t.name+'\\', this.checked)"' : '') + '>' +
        '<span class="tn">' + esc(t.name) + execNote + '</span>' +
        '<span class="td">— ' + esc(t.description) + '</span>' +
      '</label>';
    }
    grid += '<div class="tool-cat"><div class="tool-cat-title">' + esc(cat.category) + '</div>' + opts + '</div>';
  }

  const html =
    '<div class="toggle-row">' +
      '<div><div class="label">Aktifkan Override Tools</div>' +
        '<div class="desc">Saat aktif, tool diambil dari centangan di bawah (bukan env). Saat nonaktif, kembali ke SIBERFLOW_TELEGRAM_TOOLS.</div></div>' +
      '<div class="toggle ' + (override ? 'on' : '') + '" onclick="toggleToolsOverride()"></div>' +
    '</div>' +
    '<div style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<span>Status: ' + statusBadge + '</span>' +
      '<span class="muted" style="font-size:12px">' + activeSet.size + ' tool aktif</span>' +
    '</div>' +
    (override
      ? '<div style="display:flex;gap:8px;margin-bottom:16px">' +
          '<button onclick="loadEnvTools()">📥 Muat dari Env</button>' +
          '<button class="primary" onclick="saveTools()">💾 Simpan & Terapkan</button>' +
        '</div>'
      : '<div class="form-help" style="margin-bottom:16px">Aktifkan override untuk mengubah centangan. Tombol "Muat dari Env" akan menyalin config dari SIBERFLOW_TELEGRAM_TOOLS.</div>') +
    '<div class="tools-grid">' + grid + '</div>' +
    (override
      ? '<div style="display:flex;gap:8px"><button class="primary" onclick="saveTools()">💾 Simpan & Terapkan</button></div>'
      : '');
  document.getElementById("toolsWrap").innerHTML = html;
}
function toggleTool(name, checked) {
  if (checked) toolsSelection.add(name);
  else toolsSelection.delete(name);
}
async function toggleToolsOverride() {
  if (!toolsCache) return;
  toolsCache.toolsOverride = !toolsCache.toolsOverride;
  // When turning ON, seed the selection from env so the user sees the current state.
  if (toolsCache.toolsOverride) {
    toolsSelection = new Set(toolsCache.env || []);
  }
  // Persist the toggle immediately so the backend knows.
  await persistTools();
  renderTools();
}
function loadEnvTools() {
  toolsSelection = new Set(toolsCache.env || []);
  renderTools();
  toast('Centangan dimuat dari env (' + toolsSelection.size + ' tool). Klik Simpan untuk menerapkan.', true);
}
async function saveTools() {
  await persistTools();
  toast('Tools tersimpan & diterapkan. ' + (toolsCache.toolsOverride ? 'Override aktif.' : 'Kembali ke env.'), true);
  renderTools();
}
async function persistTools() {
  // Save via the ai-settings endpoint (merge into existing settings).
  const body = {
    toolsOverride: toolsCache.toolsOverride === true,
    enabledTools: Array.from(toolsSelection),
  };
  try {
    const d = await api("/api/ai-settings", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) {
      toolsCache.toolsOverride = body.toolsOverride;
      toolsCache.active = body.enabledTools;
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Image Log ──
let imageLogCache = [];
async function loadImageLog() {
  const wrap = document.getElementById("imagelogWrap");
  wrap.innerHTML = '<div class="empty"><span class="spin"></span> Memuat...</div>';
  try {
    imageLogCache = await api("/api/image-access-log");
    renderImageLog();
  } catch (e) {
    wrap.innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  }
}
function renderImageLog() {
  const wrap = document.getElementById("imagelogWrap");
  if (!imageLogCache.length) {
    wrap.innerHTML = '<div class="empty">Belum ada log akses image tool.</div>';
    return;
  }
  let rows = '';
  for (const e of imageLogCache) {
    const statusBadge = e.status === "success"
      ? '<span class="badge" style="background:#1e3d2f;color:#4ade80">OK</span>'
      : '<span class="badge" style="background:#3d1e1e;color:#f87171">ERROR</span>';
    const toolLabel = e.tool === "image_gen"
      ? "image_gen (" + esc(e.mode || "?") + ")"
      : esc(e.tool || "-");
    const errorCell = e.error ? '<span style="color:#f87171;font-size:11px">' + esc(e.error.slice(0, 200)) + '</span>' : '<span class="muted">-</span>';
    rows += '<tr>' +
      '<td class="muted" style="font-size:12px;white-space:nowrap">' + fmtDate(e.timestamp) + '</td>' +
      '<td class="mono">' + esc(e.userId ?? "-") + '</td>' +
      '<td class="mono">' + toolLabel + '</td>' +
      '<td class="mono" style="font-size:12px">' + esc(e.model || "-") + '</td>' +
      '<td style="text-align:center">' + statusBadge + '</td>' +
      '<td style="max-width:400px">' + errorCell + '</td>' +
    '</tr>';
  }
  wrap.innerHTML =
    '<div class="form-help" style="margin-bottom:12px">' + imageLogCache.length + ' entri (maks 500, tersimpan di disk — bertahan saat restart). Klik Refresh untuk update.</div>' +
    '<table><thead><tr>' +
      '<th>Waktu</th><th>User ID</th><th>Tool (Mode)</th><th>Model</th><th style="text-align:center">Status</th><th>Error</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Agent Log ──
let agentLogCache = [];
async function loadAgentLog() {
  const wrap = document.getElementById("agentlogWrap");
  wrap.innerHTML = '<div class="empty"><span class="spin"></span> Memuat...</div>';
  try {
    agentLogCache = await api("/api/agent-access-log");
    renderAgentLog();
  } catch (e) {
    wrap.innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  }
}
function renderAgentLog() {
  const wrap = document.getElementById("agentlogWrap");
  if (!agentLogCache.length) {
    wrap.innerHTML = '<div class="empty">Belum ada log akses agent tool.</div>';
    return;
  }
  let rows = '';
  for (const e of agentLogCache) {
    const statusBadge = e.status === "success"
      ? '<span class="badge" style="background:#1e3d2f;color:#4ade80">OK</span>'
      : '<span class="badge" style="background:#3d1e1e;color:#f87171">ERROR</span>';
    const taskCell = e.task
      ? '<span style="font-size:12px">' + esc(e.task.length > 200 ? e.task.slice(0, 197) + '…' : e.task) + '</span>'
      : '<span class="muted">-</span>';
    const firstLine = e.error ? (e.error.split('\n')[0] || e.error) : '';
    const errorCell = e.error
      ? '<a href="javascript:void(0)" onclick="showAgentDetail(\'' + esc(e.id) + '\')" style="color:#f87171;font-size:11px" title="Klik untuk lihat detail & request body">' + esc(firstLine.slice(0, 100)) + (firstLine.length > 100 ? '…' : '') + '</a>'
      : '<span class="muted">-</span>';
    rows += '<tr>' +
      '<td class="muted" style="font-size:12px;white-space:nowrap">' + fmtDate(e.timestamp) + '</td>' +
      '<td class="mono">' + esc(e.userId ?? "-") + '</td>' +
      '<td class="mono">' + esc(e.tool || "-") + '</td>' +
      '<td class="mono" style="font-size:12px">' + esc(e.model || "-") + '</td>' +
      '<td style="max-width:320px">' + taskCell + '</td>' +
      '<td style="text-align:center">' + statusBadge + '</td>' +
      '<td style="max-width:260px">' + errorCell + '</td>' +
    '</tr>';
  }
  wrap.innerHTML =
    '<div class="form-help" style="margin-bottom:12px">' + agentLogCache.length + ' entri (maks 500, tersimpan di disk — bertahan saat restart). Klik error untuk lihat detail & request body.</div>' +
    '<table><thead><tr>' +
      '<th>Waktu</th><th>User ID</th><th>Tool</th><th>Model</th><th>Task</th><th style="text-align:center">Status</th><th>Error</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}
async function clearAgentLog() {
  if (!confirm('Hapus SEMUA log agent? Tidak bisa diundo.')) return;
  try {
    const d = await api("/api/agent-access-log", { method: "DELETE" });
    if (d.ok) {
      agentLogCache = [];
      renderAgentLog();
      toast('Log agent dihapus.', true);
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}
async function showAgentDetail(id) {
  openModal('Agent Log Detail', '<div class="empty"><span class="spin"></span> Memuat detail...</div>');
  try {
    const e = await api("/api/agent-access-log/" + encodeURIComponent(id));
    if (!e || e.error === "Log entry not found") {
      openModal('Agent Log Detail', '<div class="empty">Entri tidak ditemukan.</div>');
      return;
    }
    const statusBadge = e.status === "success"
      ? '<span class="badge" style="background:#1e3d2f;color:#4ade80">OK</span>'
      : '<span class="badge" style="background:#3d1e1e;color:#f87171">ERROR</span>';
    let body = '<table class="kv">' +
      '<tr><th>Waktu</th><td>' + esc(fmtDate(e.timestamp)) + '</td></tr>' +
      '<tr><th>User ID</th><td class="mono">' + esc(e.userId ?? "-") + '</td></tr>' +
      '<tr><th>Tool</th><td class="mono">' + esc(e.tool || "-") + '</td></tr>' +
      '<tr><th>Model</th><td class="mono">' + esc(e.model || "-") + '</td></tr>' +
      '<tr><th>Status</th><td>' + statusBadge + '</td></tr>' +
      '<tr><th>Task</th><td style="font-size:12px;white-space:pre-wrap;word-break:break-word">' + esc(e.task || "-") + '</td></tr>';
    if (e.error) {
      body += '<tr><th style="vertical-align:top">Error</th><td><pre style="white-space:pre-wrap;word-break:break-word;color:#f87171;font-size:11px;background:#2a1414;padding:8px;border-radius:4px;max-height:300px;overflow:auto">' + esc(e.error) + '</pre></td></tr>';
    }
    if (e.requestBody) {
      body += '<tr><th style="vertical-align:top">Request Body</th><td><details><summary style="cursor:pointer;font-size:12px;color:#60a5fa">Tampilkan JSON (' + e.requestBody.length + ' chars)</summary><pre style="margin-top:6px;white-space:pre-wrap;word-break:break-word;font-size:11px;background:#161e2a;padding:8px;border-radius:4px;max-height:400px;overflow:auto">' + esc(e.requestBody) + '</pre></details></td></tr>';
    }
    body += '</table>';
    openModal('Agent Log Detail', body);
  } catch (e) {
    openModal('Agent Log Detail', '<div class="empty">Gagal: ' + esc(e.message) + '</div>');
  }
}

// ── Sessions ──
let sessionsCache = [];
async function loadSessions() {
  const wrap = document.getElementById("sessionsWrap");
  wrap.innerHTML = '<div class="empty"><span class="spin"></span> Memuat...</div>';
  try {
    const data = await api("/api/sessions");
    sessionsCache = Array.isArray(data) ? data : [];
    renderSessions();
  } catch (e) {
    wrap.innerHTML = '<div class="empty">Gagal memuat: ' + esc(e.message) + '</div>';
  }
}
function renderSessions() {
  const wrap = document.getElementById("sessionsWrap");
  if (!sessionsCache.length) {
    wrap.innerHTML = '<div class="empty">Belum ada session telegram.</div>';
    return;
  }
  let html = '<table><thead><tr>' +
    '<th>Nama</th><th>Tipe</th><th>Chat ID</th><th>Username</th>' +
    '<th style="text-align:center">Pesan</th><th style="text-align:center">Anggota</th><th>Update</th><th style="text-align:right">Aksi</th>' +
    '</tr></thead><tbody>';
  for (const s of sessionsCache) {
    const typeBadge = '<span class="badge ' + s.chatType + '">' + s.chatType + '</span>' +
      (s.threadId ? '<br><span class="badge thread">thread ' + s.threadId + '</span>' : '');
    html += '<tr>' +
      '<td class="name-cell"><strong>' + esc(s.name || "(tanpa nama)") + '</strong><span class="sid">' + esc(s.id) + '</span></td>' +
      '<td>' + typeBadge + '</td>' +
      '<td class="mono">' + (s.chatId != null ? s.chatId : "-") + '</td>' +
      '<td class="mono">' + esc(s.username || "-") + '</td>' +
      '<td style="text-align:center">' + s.messageCount + '</td>' +
      '<td style="text-align:center">' + (s.knownMembersCount || 0) + '</td>' +
      '<td class="muted" style="font-size:12px">' + fmtDate(s.updatedAt) + '</td>' +
      '<td><div class="row-actions">' +
        '<button class="icon-btn" title="Detail pesan" onclick="showDetail(\\''+s.id+'\\')">📄</button>' +
        '<button class="icon-btn" title="Workdir" onclick="showWorkdir(\\''+s.id+'\\')">📁</button>' +
        '<button class="icon-btn" title="Kirim pesan ke chat ini" onclick="fillSendAndOpen(\\''+s.id+'\\')">✉</button>' +
        '<button class="icon-btn danger" title="Hapus session" onclick="deleteSession(\\''+s.id+'\\')">🗑</button>' +
      '</div></td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ── Detail (message log) ──
async function showDetail(id) {
  openModal("📄 Detail: " + id, '<div class="empty"><span class="spin"></span> Memuat pesan...</div>');
  try {
    const d = await api("/api/session/" + encodeURIComponent(id));
    renderDetail(d);
  } catch (e) {
    document.getElementById("modalBody").innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  }
}
function renderDetail(d) {
  const meta = '<div class="msg-meta">' +
    'Provider: <strong>' + esc(d.provider) + '</strong> · Model: <strong>' + esc(d.model) + '</strong><br>' +
    'Dibuat: ' + fmtDate(d.createdAt) + ' · Update: ' + fmtDate(d.updatedAt) +
    (d.usage && d.usage.total ? ' · Token total: ' + (d.usage.total.promptTokens + d.usage.total.completionTokens) : '') +
    '</div>';
  let rows = '';
  for (const m of d.messages) {
    const roleClass = "role-" + m.role;
    let toolCell = '';
    if (m.toolCalls && m.toolCalls.length) {
      toolCell = m.toolCalls.map(tc => {
        let pretty = tc.arguments;
        try { pretty = JSON.stringify(JSON.parse(tc.arguments), null, 2); } catch {}
        return '<div style="margin-bottom:6px"><span class="tool-badge">🔧 ' + esc(tc.name) + '</span>' +
          '<div class="tool-args">' + esc(pretty) + '</div></div>';
      }).join("");
    }
    if (m.toolResult) {
      toolCell = '<span class="tool-badge">← ' + esc(m.toolResult.name) + '</span>';
    }
    const content = '<div class="msg-content collapsed">' + esc(m.content || "(kosong)") + '</div>';
    rows += '<tr>' +
      '<td class="mono muted" style="width:40px">' + m.index + '</td>' +
      '<td class="msg-role ' + roleClass + '" style="width:110px">' + m.label + '</td>' +
      '<td class="msg-content">' + content + (m.truncated ? '<div class="muted" style="font-size:11px;margin-top:4px">✂ truncated (' + m.fullLength + ' chars)</div>' : '') + '</td>' +
      '<td style="width:280px">' + toolCell + '</td>' +
    '</tr>';
  }
  const html = meta + '<table class="msg-table"><thead><tr>' +
    '<th>#</th><th>Role</th><th>Content</th><th>Tool</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
  document.getElementById("modalBody").innerHTML = html;
  // Bind click-to-expand on each content cell
  document.querySelectorAll(".msg-content").forEach(el => {
    el.addEventListener("click", () => el.classList.toggle("collapsed"));
  });
}

// ── Workdir ──
async function showWorkdir(id) {
  openModal("📁 Workdir: " + id, '<div class="empty"><span class="spin"></span> Memuat...</div>');
  try {
    const d = await api("/api/workdir/" + encodeURIComponent(id));
    let html = '<div class="msg-meta mono" style="font-size:12px">' + esc(d.path) + '</div>';
    if (!d.entries || !d.entries.length) {
      html += '<div class="empty">Workdir kosong.</div>';
    } else {
      const dirs = d.entries.filter(e => e.isDir).sort((a,b)=>a.path.localeCompare(b.path));
      const files = d.entries.filter(e => !e.isDir).sort((a,b)=>a.path.localeCompare(b.path));
      html += '<div class="file-tree" style="padding:16px 20px">';
      for (const e of dirs) html += '<div class="item dir">📁 ' + esc(e.path) + '/</div>';
      for (const e of files) html += '<div class="item file">📄 ' + esc(e.path) + ' <span class="size">(' + fmtSize(e.size) + ')</span></div>';
      html += '</div>';
    }
    document.getElementById("modalBody").innerHTML = html;
  } catch (e) {
    document.getElementById("modalBody").innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  }
}

// ── Delete ──
async function deleteSession(id) {
  if (!confirm("Hapus session dan workdir?\\n\\n" + id + "\\n\\nTindakan ini tidak dapat dibatalkan.")) return;
  try {
    const d = await api("/api/delete/" + encodeURIComponent(id), { method: "POST" });
    if (d.ok) {
      toast("Session dihapus (file: " + d.removed + ", workdir: " + d.workdirRemoved + ")", true);
      loadSessions();
    } else {
      toast("Gagal: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Send Message (modal) ──
function openSendModal() {
  document.getElementById("sendOverlay").classList.add("active");
}
function closeSendModal() {
  document.getElementById("sendOverlay").classList.remove("active");
}
function fillSendAndOpen(id) {
  const s = sessionsCache.find(x => x.id === id);
  if (s && s.chatId != null) {
    document.getElementById("sendChatId").value = s.chatId;
    document.getElementById("sendThreadId").value = s.threadId || "";
  }
  openSendModal();
}
async function sendMessage() {
  const chatId = document.getElementById("sendChatId").value.trim();
  const threadId = document.getElementById("sendThreadId").value.trim();
  const text = document.getElementById("sendText").value.trim();
  if (!chatId || !text) { toast("Chat ID dan pesan wajib diisi", false); return; }
  try {
    const body = { chatId: Number(chatId), text };
    if (threadId) body.threadId = Number(threadId);
    const d = await api("/api/send", { method: "POST", body: JSON.stringify(body) });
    if (d.ok) {
      toast("Pesan terkirim (msg id: " + d.messageId + ")", true);
      document.getElementById("sendText").value = "";
      closeSendModal();
    } else {
      toast("Gagal kirim: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Overview ──
async function loadOverview() {
  try {
    const data = await api("/api/sessions");
    sessionsCache = Array.isArray(data) ? data : [];
    const total = data.length;
    const privates = data.filter(s => s.chatType === "private").length;
    const groups = data.filter(s => s.chatType === "group" || s.chatType === "supergroup").length;
    const threads = data.filter(s => s.threadId != null).length;
    const totalMsgs = data.reduce((a, s) => a + (s.messageCount || 0), 0);
    document.getElementById("statGrid").innerHTML =
      statCard(total, "Total Session") +
      statCard(privates, "Private Chat") +
      statCard(groups, "Group / Supergroup") +
      statCard(threads, "Forum Thread") +
      statCard(totalMsgs, "Total Pesan");
    // Recent 5
    const recent = data.slice(0, 5);
    let html = '<table><thead><tr><th>Nama</th><th>Tipe</th><th>Pesan</th><th>Update</th></tr></thead><tbody>';
    for (const s of recent) {
      html += '<tr><td><strong>' + esc(s.name || "-") + '</strong></td>' +
        '<td><span class="badge ' + s.chatType + '">' + s.chatType + '</span></td>' +
        '<td>' + s.messageCount + '</td>' +
        '<td class="muted" style="font-size:12px">' + fmtDate(s.updatedAt) + '</td></tr>';
    }
    html += '</tbody></table>';
    document.getElementById("recentWrap").innerHTML = html;
  } catch (e) {
    document.getElementById("statGrid").innerHTML = '<div class="empty">Gagal memuat: ' + esc(e.message) + '</div>';
  }
}
function statCard(val, lbl) {
  return '<div class="stat-card"><div class="val">' + val + '</div><div class="lbl">' + lbl + '</div></div>';
}

// ── Generic modal ──
function openModal(title, bodyHtml) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("overlay").classList.add("active");
}
function closeModal() {
  document.getElementById("overlay").classList.remove("active");
}

// Init
loadSessions();
</script>
</body>
</html>`;
