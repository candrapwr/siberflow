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
  </nav>
  <div class="sidebar-foot" id="sidebarFoot">v0.1.0</div>
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
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const headers = { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };

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
async function api(path, opts) {
  const res = await fetch(path, { headers, ...(opts || {}) });
  return res.json();
}

// ── Navigation ──
function goPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("page-" + name).classList.add("active");
  document.querySelector('.nav-item[data-page="' + name + '"]').classList.add("active");
  const titles = { sessions: "Sessions", overview: "Overview" };
  document.getElementById("pageTitle").textContent = titles[name] || name;
  const topActions = document.getElementById("topActions");
  if (name === "sessions") {
    topActions.innerHTML = '<button class="primary" onclick="loadSessions()">⟳ Refresh</button>';
  } else if (name === "overview") {
    topActions.innerHTML = '<button class="primary" onclick="loadOverview()">⟳ Refresh</button>';
    loadOverview();
  } else {
    topActions.innerHTML = '';
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
