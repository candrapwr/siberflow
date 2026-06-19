# Siberflow

AI platform dengan dukungan multi-provider, tool calling streaming, sandbox file, akses database, persistensi multi-session, dan task checklist. Interface saat ini: **CLI**, **VSCode extension** (sidebar panel), dan **Desktop app** (Electron + React).

## Provider yang didukung

- `deepseek` (default) — `deepseek-v4-flash`, `deepseek-reasoner`
- `gemini` — `gemini-2.5-flash` (via endpoint OpenAI-compatible Google)
- `openai` — `gpt-5.4-nano` (pakai `/v1/chat/completions`)
- `openai-responses` — `gpt-5.1-codex-mini` (pakai `/v1/responses`; untuk codex / o-series / gpt-5 yang tidak didukung chat completions)
- `grok` — `grok-build-0.1` (xAI, via endpoint OpenAI-compatible)
- `qwen` — `qwen3.7-plus` (Alibaba DashScope / MaaS, OpenAI-compatible). Default endpoint internasional; custom MaaS workspace bisa override via `SIBERFLOW_BASE_URL`
- `zai` — `glm-5.2` (Z.AI / GLM, OpenAI-compatible). Default ke general endpoint `https://api.z.ai/api/paas/v4`; kalau perlu GLM Coding endpoint bisa override via `SIBERFLOW_BASE_URL`
- `claude` — `claude-sonnet-4-5` (Anthropic, via OpenAI-compatible chat completions endpoint)

## Struktur

npm workspaces monorepo.

- `packages/core` — agent loop, provider adapter, tool registry, file/db tools, session store, context optimize, task store
- `packages/cli` — REPL interaktif, slash commands, ASCII banner, streaming render
- `packages/vscode-ext` — VSCode extension dengan sidebar chat panel, settings UI, markdown render
- `packages/desktop` — Electron desktop app (React + Vite), standalone UI, multi-session sidebar, safeStorage API key

Semua sesi tersimpan di `~/.siberflow/sessions/` — cross-compat antar CLI, VSCode, dan Desktop.

## CLI

### Quick start (dev)

```bash
npm install
cp .env.example .env
# isi minimal salah satu API key: DEEPSEEK_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / XAI_API_KEY / DASHSCOPE_API_KEY / ZAI_API_KEY / ANTHROPIC_API_KEY

npm run dev:cli
```

### Install global (Ubuntu / macOS)

Prasyarat: Node 20+. Setelah clone repo:

```bash
npm install
npm run build
npm link -w @siberflow/cli
```

Sekarang `siberflow` bisa dipanggil dari direktori manapun. CLI mencari `.env` dengan walk-up dari cwd — taruh `.env` di project tempat kamu kerja, atau export env vars di `~/.bashrc`.

Uninstall: `npm unlink -w @siberflow/cli`.

**Catatan**: `npm link` membuat symlink ke folder repo — jangan pindah/hapus repo setelah link.

![Siberflow CLI](./ss_cli.png)

## VSCode Extension

### Mode dev (F5)

```bash
npm install
cd packages/vscode-ext
code .       # buka di VSCode, lalu tekan F5
```

Extension Development Host terbuka. Icon Siberflow muncul di activity bar kiri.

Pertama kali pakai, settings panel auto-muncul minta API key + pilihan provider. Tersimpan di **VSCode SecretStorage** (encrypted) — tidak perlu `.env`.

![Siberflow VSCode Extension](./ss_vscode.png)

### Build VSIX untuk install permanen / di-share

Dari root project:
```bash
npm run package:vscode
# → packages/vscode-ext/siberflow-chat-0.1.0.vsix
```

Install file `.vsix` di VSCode user lain:

- **GUI**: Cmd+Shift+P → **"Extensions: Install from VSIX…"** → pilih file
- **CLI**: `code --install-extension siberflow-chat-0.1.0.vsix`

VSIX self-contained (~40 KB) — esbuild sudah inline `@siberflow/core` + `marked`. Tidak perlu publish ke marketplace.

Update versi: edit `version` di `packages/vscode-ext/package.json`, lalu `npm run package:vscode` lagi.

## Desktop App (Electron)

Aplikasi desktop standalone (mirip Claude Desktop). UI dibangun dari nol dengan React + Vite, terpisah dari CLI/VSCode karena kebutuhan desktop berbeda (window management, folder picker per-session, sidebar multi-session). Mengkonsumsi `@siberflow/core` langsung — semua logic agent, tools, sessions reused.

### Mode dev

```bash
npm run build:core      # build core dulu (prasyarat)
npm run dev:desktop     # electron-vite dev (HMR untuk renderer)
```

Pertama kali buka, settings modal muncul untuk pilih provider + input API key. API key disimpan via **Electron `safeStorage`** (OS keychain, encrypted) di `~/Library/Application Support/Siberflow/siberflow-keys.json`.

### Build installer

```bash
npm run package:desktop       # build + package (auto-detect platform)
npm run package:mac           # macOS (.dmg)
npm run package:win           # Windows (.exe / NSIS)
npm run package:linux         # Linux (.AppImage)
```

Semua script di atas bisa dijalankan dari **root** repo maupun dari `packages/desktop`. Native modules (`ssh2`, `sqlite3`) otomatis di-rebuild untuk Electron ABI via `electron-builder install-app-deps` yang ada di dalam script `package:*` (tidak pakai `postinstall` agar tidak rekursif).

Output: `packages/desktop/dist/Siberflow-<version>-<arch>.dmg` (macOS, ~110MB).

> **Windows:** jika `npm run package:win` gagal dengan `electron-builder is not recognized` atau `app-builder.exe ENOENT`, force install binary-nya:
> ```powershell
> npm install electron-builder@25 --force
> npm install app-builder-bin --force
> npm run package:win
> ```
> Panduan lengkap build Windows (termasuk prasyarat Python + VS Build Tools): lihat [BUILD-WINDOWS.md](BUILD-WINDOWS.md).

### ⚠️ Batasan Cross-Platform Build

**Installer desktop harus di-build di OS target yang sama.** Tidak bisa cross-compile dari satu OS ke OS lain untuk menghasilkan installer yang berfungsi.

| Build dari | macOS `.dmg` | Windows `.exe` | Linux `.AppImage` |
|---|---|---|---|
| **macOS** | ✅ berfungsi | ⚠️ installer terbentuk tapi **app crash** | ⚠️ sama |
| **Windows** | ⚠️ sama | ✅ berfungsi | ⚠️ sama |
| **Linux** | ⚠️ sama | ⚠️ sama | ✅ berfungsi |

**Kenapa?** Native modules (`ssh2`, `sqlite3`, `cpu-features`) adalah machine code yang harus di-compile untuk tiap platform:
- macOS → `Mach-O arm64/x64`
- Windows → `PE32 x64`
- Linux → `ELF x64`

Dari Mac, native modules ter-compile jadi `Mach-O arm64`. Saat installer Windows hasil cross-compile dijalankan → load native module Mach-O di Windows → **crash instan**. Shortcut desktop tidak dibuat (dibuat saat first-run sukses), yang tersisa cuma uninstaller. `electron-builder` / `electron-rebuild` hanya rebuild untuk platform yang sedang jalan, tidak ada flag cross-compile untuk native addons.

**Solusi dapat installer per-platform:**

1. **Build di OS target** — paling simpel. Clone repo di Windows untuk `.exe`, di Linux untuk `.AppImage`.
2. **GitHub Actions** (rekomendasi) — build otomatis di runner (`windows-latest` / `ubuntu-latest` / `macos-latest`). Push tag → semua platform ter-build + upload ke Releases. Native modules ter-compile asli untuk tiap platform.
3. **Virtual Machine** — install VM Windows/Linux di Mac, build di sana.

**Catatan Untuk Build Desktop:** di path root:
```bash
npm install electron-builder@25 --force
npm install app-builder-bin --force
```

**Catatan Linux:** sebelum build, install toolchain native module:
```bash
sudo apt update
sudo apt install -y build-essential python3 make g++
# runtime dependencies untuk Electron:
sudo apt install -y libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xauth \
  libatspi2.0-0 libdrm2 libgbm1 libasound2
```

Kalau `npm install` timeout/`SIGINT` karena `postinstall` (electron-builder download Electron binary ~180MB), skip dulu lalu rebuild manual:
```bash
npm install
cd packages/desktop && npm run rebuild
```

### Fitur desktop

- **Multi-session sidebar** — daftar chat dikelompokkan per folder project, switch/new/delete, rename inline (double-click)
- **Folder picker** — tiap chat session terikat ke satu folder project (sandbox tool file/exec); pilih via native dialog saat new chat
- **Layout centered** — messages & composer di-tengah (max-width 760px) untuk readability, task panel floating di kanan-atas
- **Resizable sidebar** — drag border kanan sidebar untuk resize
- **Branding lengkap** — app name, icon (.icns/.ico/.png), window title "Siberflow"

## Fitur ringkas

- **Streaming response** — token muncul real-time, support markdown
- **File dan shell tools** — `read_file`, `write_file`, `edit_file`, `copy_file`, `list_dir`, `exec`
- **Database query tool** — `db_query` mendukung `mysql`, `postgresql`, dan `sqlite`; query bebas, optional `params`, SQLite path tetap dibatasi ke project dir
- **Task checklist** — opt-in via env / settings; AI maintain checklist multi-step yang bisa di-resume setelah Ctrl+C atau session restart
- **Context optimization** — buang tool history dari turn lama (default aktif); current task tetap utuh. Dua mode via `SIBERFLOW_CONTEXT_OPTIMIZE_MODE`: `drop` (buang total, default) atau `summary` (sisakan tag `[SUMMARY]` berisi *signature* per tool — nama + identifier ringkas seperti `exec("df -h")` / `write_file("src/foo.ts")`; payload berat dan result tetap dibuang). Defense-in-depth: provider & serialization selalu menjamin assistant message punya content atau tool_calls (fix error 400 DeepSeek)
- **Auto-continue** — sambung otomatis respons yang kepotong max_tokens
- **Silent task_update** — tool `task_update` tetap dieksekusi tapi tidak ditampilkan di transcript (CLI, VSCode, Desktop); efeknya hanya terlihat di task checklist
- **Multi-session** — sesi tersimpan per project, picker saat startup
- **Debug tracing** — env `SIBERFLOW_DEBUG=true` untuk log HTTP/finish_reason/usage

## Developer docs

Detail teknis, struktur kode, protokol VSCode extension, cara menambah provider/tool, dan internal rendering di [DEVELOPMENT.md](DEVELOPMENT.md).
