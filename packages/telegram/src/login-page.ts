/**
 * Inline HTML for the admin web login page.
 *
 * A separate page (served when no valid session is present) that displays a
 * login code and polls the backend until the admin approves it via
 * `/login <code>` in Telegram. On approval it stores the session token in
 * localStorage and reloads into the dashboard.
 *
 * The code is passed into the HTML via string replacement so it renders
 * immediately on first paint.
 */
export const LOGIN_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Siberflow Admin — Login</title>
<style>
  :root {
    --bg: #0f1117;
    --panel: #181b24;
    --panel-2: #1f2330;
    --border: #2a2f3d;
    --text: #e6e8ee;
    --muted: #8b92a4;
    --accent: #4f9cf9;
    --ok: #4ade80;
    --danger: #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    font-size: 14px;
  }
  .login-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 40px;
    max-width: 420px;
    width: calc(100% - 32px);
    text-align: center;
  }
  .login-card h1 {
    font-size: 20px;
    margin-bottom: 6px;
  }
  .login-card .sub {
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 28px;
  }
  .code-box {
    background: var(--panel-2);
    border: 2px dashed var(--border);
    border-radius: 12px;
    padding: 28px 16px;
    margin-bottom: 24px;
  }
  .code-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--muted);
    margin-bottom: 12px;
  }
  .code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 40px;
    font-weight: 700;
    letter-spacing: 8px;
    color: var(--accent);
    line-height: 1;
  }
  .status {
    font-size: 13px;
    color: var(--muted);
    min-height: 20px;
    margin-bottom: 16px;
  }
  .status.waiting::before {
    content: "";
    display: inline-block;
    width: 12px; height: 12px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 8px;
  }
  .status.ok { color: var(--ok); font-weight: 600; }
  .status.err { color: var(--danger); }
  .steps {
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.8;
  }
  .steps strong { color: var(--text); }
  .steps code {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    background: var(--panel-2);
    padding: 1px 6px;
    border-radius: 3px;
    color: var(--accent);
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="login-card">
  <h1>🤖 Siberflow Admin</h1>
  <div class="sub">Masuk dengan kode login</div>
  <div class="code-box">
    <div class="code-label">Kode Login</div>
    <div class="code" id="loginCode">__CODE__</div>
  </div>
  <div class="status waiting" id="status">Menunggu persetujuan admin...</div>
  <div class="steps">
    <strong>Cara login:</strong><br>
    1. Buka private chat dengan bot di Telegram<br>
    2. Kirim: <code id="cmdExample">/login __CODE__</code><br>
    3. Tunggu hingga login berhasil
  </div>
</div>
<script>
const CODE = "__CODE__";
let pollTimer = null;
let pollCount = 0;

async function poll() {
  pollCount++;
  try {
    const res = await fetch("/api/login/poll?code=" + encodeURIComponent(CODE));
    const data = await res.json();
    if (data.status === "approved" && data.token) {
      localStorage.setItem("admin_session", data.token);
      document.getElementById("status").className = "status ok";
      document.getElementById("status").textContent = "✅ Login berhasil! Memuat dashboard...";
      clearInterval(pollTimer);
      setTimeout(() => location.reload(), 800);
      return;
    }
    if (data.status === "expired") {
      document.getElementById("status").className = "status err";
      document.getElementById("status").textContent = "❌ Kode kedaluwarsa. Muat ulang halaman untuk kode baru.";
      clearInterval(pollTimer);
      return;
    }
    // Still pending — keep polling.
  } catch (e) {
    // Network blip — keep polling.
  }
  // Safety: stop after ~5 minutes of polling.
  if (pollCount > 150) {
    document.getElementById("status").className = "status err";
    document.getElementById("status").textContent = "❌ Timeout. Muat ulang halaman.";
    clearInterval(pollTimer);
  }
}

// Poll every 2 seconds.
pollTimer = setInterval(poll, 2000);
poll();
</script>
</body>
</html>`;
