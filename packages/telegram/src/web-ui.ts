/**
 * Inline HTML/CSS/JS for the Telegram bot admin web UI.
 *
 * Kept in a separate module from the server logic so the server file stays
 * focused on routing/handlers. This is a single-page app: it fetches the JSON
 * API (with the token from the URL) and renders everything client-side.
 *
 * The token is read from the ?token= query param on first load and reused for
 * all subsequent API calls via the Authorization: Bearer header.
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
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
  }
  header {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .sub { color: var(--muted); font-size: 12px; }
  main { max-width: 1200px; margin: 0 auto; padding: 24px; }
  section { margin-bottom: 32px; }
  h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    margin: 0 0 12px;
  }

  /* Buttons */
  button {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 5px 10px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.15s, border-color 0.15s;
  }
  button:hover { background: var(--border); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button.danger { color: var(--danger); border-color: var(--border); }
  button.danger:hover { background: var(--danger); color: #fff; border-color: var(--danger); }
  button.small { padding: 3px 7px; font-size: 11px; }

  /* Forms */
  input, textarea, select {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { resize: vertical; min-height: 60px; }

  /* Sessions table */
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    font-weight: 600;
  }
  tr:hover { background: var(--panel); }
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
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }

  /* Modal */
  .overlay {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    padding: 24px;
    overflow: auto;
  }
  .overlay.active { display: block; }
  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    max-width: 1000px;
    margin: 0 auto;
    overflow: hidden;
  }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
  }
  .modal-head h3 { margin: 0; font-size: 15px; word-break: break-all; }
  .modal-body { padding: 0; max-height: 75vh; overflow: auto; }

  /* Message log table */
  .msg-table td { vertical-align: top; }
  .msg-role { white-space: nowrap; }
  .msg-content {
    max-width: 560px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
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
  .expand-btn { color: var(--accent); cursor: pointer; font-size: 11px; margin-top: 4px; display: inline-block; }

  /* Workdir tree */
  .file-tree { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
  .file-tree .dir { color: var(--accent); }
  .file-tree .file { color: var(--text); }
  .file-tree .size { color: var(--muted); }

  /* Send form */
  .send-form { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .send-form .field { display: flex; flex-direction: column; gap: 4px; }
  .send-form label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--panel-2); border: 1px solid var(--border);
    padding: 12px 18px; border-radius: 8px;
    z-index: 200; display: none; max-width: 380px;
  }
  .toast.show { display: block; }
  .toast.ok { border-color: var(--ok); }
  .toast.err { border-color: var(--danger); }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<header>
  <div>
    <h1>🤖 Siberflow Telegram Admin</h1>
    <div class="sub">Manajemen session bot Telegram</div>
  </div>
  <div>
    <button onclick="loadSessions()" class="primary">⟳ Refresh</button>
  </div>
</header>

<main>
  <!-- Send message -->
  <section>
    <h2>Kirim Pesan</h2>
    <div class="send-form">
      <div class="field">
        <label>Chat ID</label>
        <input id="sendChatId" placeholder="702257984" style="width:180px">
      </div>
      <div class="field">
        <label>Thread ID (opsional)</label>
        <input id="sendThreadId" placeholder="" style="width:120px">
      </div>
      <div class="field" style="flex:1; min-width:280px;">
        <label>Pesan</label>
        <textarea id="sendText" placeholder="Tulis pesan..." style="width:100%"></textarea>
      </div>
      <button onclick="sendMessage()" class="primary">➤ Kirim</button>
    </div>
  </section>

  <!-- Sessions list -->
  <section>
    <h2>Daftar Session <span id="sessCount" class="muted"></span></h2>
    <div id="sessionsWrap">
      <div class="empty"><span class="spin"></span> Memuat...</div>
    </div>
  </section>
</main>

<!-- Modal -->
<div class="overlay" id="overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-head">
      <h3 id="modalTitle">Detail</h3>
      <button onclick="closeModal()">✕ Tutup</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
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
  document.getElementById("sessCount").textContent = "(" + sessionsCache.length + ")";
  if (!sessionsCache.length) {
    wrap.innerHTML = '<div class="empty">Belum ada session telegram.</div>';
    return;
  }
  let html = '<table><thead><tr>' +
    '<th>Nama</th><th>Tipe</th><th>Chat ID</th><th>Username</th>' +
    '<th>Pesan</th><th>Anggota</th><th>Update</th><th>Aksi</th>' +
    '</tr></thead><tbody>';
  for (const s of sessionsCache) {
    const typeBadge = '<span class="badge ' + s.chatType + '">' + s.chatType + '</span>' +
      (s.threadId ? ' <span class="badge thread">thread ' + s.threadId + '</span>' : '');
    html += '<tr>' +
      '<td><strong>' + esc(s.name || "(tanpa nama)") + '</strong><br><span class="muted mono" style="font-size:11px">' + esc(s.id) + '</span></td>' +
      '<td>' + typeBadge + '</td>' +
      '<td class="mono">' + (s.chatId != null ? s.chatId : "-") + '</td>' +
      '<td class="mono">' + esc(s.username || "-") + '</td>' +
      '<td>' + s.messageCount + '</td>' +
      '<td>' + (s.knownMembersCount || 0) + '</td>' +
      '<td class="muted" style="font-size:12px">' + fmtDate(s.updatedAt) + '</td>' +
      '<td><div class="actions">' +
        '<button class="small" onclick="showDetail(\\''+s.id+'\\')">📄 Detail</button>' +
        '<button class="small" onclick="showWorkdir(\\''+s.id+'\\')">📁 Workdir</button>' +
        '<button class="small" onclick="fillSend(\\''+s.id+'\\')">✉ Isi Chat ID</button>' +
        '<button class="small danger" onclick="deleteSession(\\''+s.id+'\\')">🗑 Hapus</button>' +
      '</div></td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ── Detail (message log) ──
async function showDetail(id) {
  openModal("Detail: " + id, '<div class="empty"><span class="spin"></span> Memuat pesan...</div>');
  try {
    const d = await api("/api/session/" + encodeURIComponent(id));
    renderDetail(d);
  } catch (e) {
    document.getElementById("modalBody").innerHTML = '<div class="empty">Gagal: ' + esc(e.message) + '</div>';
  }
}
function renderDetail(d) {
  const meta = '<div style="padding:12px 18px;background:var(--panel-2);border-bottom:1px solid var(--border);font-size:12px" class="muted">' +
    'Provider: ' + esc(d.provider) + ' · Model: ' + esc(d.model) + ' · Dibuat: ' + fmtDate(d.createdAt) +
    ' · Update: ' + fmtDate(d.updatedAt) +
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
        return '<div><span class="tool-badge">🔧 ' + esc(tc.name) + '</span>' +
          '<div class="tool-args">' + esc(pretty) + '</div></div>';
      }).join("");
    }
    if (m.toolResult) {
      toolCell = '<span class="tool-badge">← ' + esc(m.toolResult.name) + '</span>';
    }
    const trunc = m.truncated ? ' <span class="expand-btn" onclick="this.previousElementSibling.classList.toggle(\\'collapsed\\')">⇕ tampilkan semua (' + m.fullLength + ' chars)</span>' : '';
    const content = '<div class="msg-content collapsed" onclick="this.classList.toggle(\\'collapsed\\')">' + esc(m.content || "(kosong)") + '</div>';
    rows += '<tr>' +
      '<td class="mono muted" style="width:40px">' + m.index + '</td>' +
      '<td class="msg-role ' + roleClass + '"><strong>' + m.label + '</strong></td>' +
      '<td class="msg-content">' + content + '</td>' +
      '<td style="width:280px">' + toolCell + '</td>' +
    '</tr>';
  }
  const html = meta + '<table class="msg-table"><thead><tr>' +
    '<th>#</th><th>Role</th><th>Content</th><th>Tool</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
  document.getElementById("modalBody").innerHTML = html;
}

// ── Workdir ──
async function showWorkdir(id) {
  openModal("Workdir: " + id, '<div class="empty"><span class="spin"></span> Memuat...</div>');
  try {
    const d = await api("/api/workdir/" + encodeURIComponent(id));
    let html = '<div style="padding:12px 18px;background:var(--panel-2);border-bottom:1px solid var(--border)" class="mono muted" style="font-size:12px">' + esc(d.path) + '</div>';
    if (!d.entries || !d.entries.length) {
      html += '<div class="empty">Workdir kosong.</div>';
    } else {
      const dirs = d.entries.filter(e => e.isDir).sort((a,b)=>a.path.localeCompare(b.path));
      const files = d.entries.filter(e => !e.isDir).sort((a,b)=>a.path.localeCompare(b.path));
      html += '<div class="file-tree" style="padding:14px 18px">';
      for (const e of dirs) html += '<div class="dir">📁 ' + esc(e.path) + '/</div>';
      for (const e of files) html += '<div class="file">📄 ' + esc(e.path) + ' <span class="size">(' + fmtSize(e.size) + ')</span></div>';
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

// ── Send ──
function fillSend(id) {
  const s = sessionsCache.find(x => x.id === id);
  if (s && s.chatId != null) {
    document.getElementById("sendChatId").value = s.chatId;
    if (s.threadId) document.getElementById("sendThreadId").value = s.threadId;
  }
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
    } else {
      toast("Gagal kirim: " + (d.error || "unknown"), false);
    }
  } catch (e) {
    toast("Gagal: " + e.message, false);
  }
}

// ── Modal ──
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
