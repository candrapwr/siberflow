# Siberflow

AI platform dengan dukungan multi-provider, tool calling streaming, sandbox file, persistensi multi-session, dan task checklist. Interface saat ini: **CLI** dan **VSCode extension** (sidebar panel). Web menyusul.

## Provider yang didukung

- `deepseek` (default) — `deepseek-chat`, `deepseek-reasoner`
- `gemini` — `gemini-2.5-flash` (via endpoint OpenAI-compatible Google)
- `openai` — `gpt-5.4-nano` (pakai `/v1/chat/completions`)
- `openai-responses` — `gpt-5.1-codex-mini` (pakai `/v1/responses`; untuk codex / o-series / gpt-5 yang tidak didukung chat completions)

## Struktur

npm workspaces monorepo.

- `packages/core` — agent loop, provider adapter, tool registry, session store, context optimize, task store
- `packages/cli` — REPL interaktif, slash commands, ASCII banner, streaming render
- `packages/vscode-ext` — VSCode extension dengan sidebar chat panel, settings UI, markdown render

Semua sesi tersimpan di `~/.siberflow/sessions/` — cross-compat antar CLI dan VSCode.

## CLI

### Quick start (dev)

```bash
npm install
cp .env.example .env
# isi minimal salah satu API key: DEEPSEEK_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY

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

## VSCode Extension

### Mode dev (F5)

```bash
npm install
cd packages/vscode-ext
code .       # buka di VSCode, lalu tekan F5
```

Extension Development Host terbuka. Icon Siberflow muncul di activity bar kiri.

Pertama kali pakai, settings panel auto-muncul minta API key + pilihan provider. Tersimpan di **VSCode SecretStorage** (encrypted) — tidak perlu `.env`.

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

## Fitur ringkas

- **Streaming response** — token muncul real-time, support markdown
- **Tool calling sandbox** — `read_file`, `write_file`, `edit_file`, `copy_file`, `list_dir`, `exec` — semua sandboxed ke project dir
- **Task checklist** — opt-in via env / settings; AI maintain checklist multi-step yang bisa di-resume setelah Ctrl+C atau session restart
- **Context optimization** — buang tool history dari turn lama (opt-in); current task tetap utuh
- **Auto-continue** — sambung otomatis respons yang kepotong max_tokens
- **Multi-session** — sesi tersimpan per project, picker saat startup
- **Debug tracing** — env `SIBERFLOW_DEBUG=true` untuk log HTTP/finish_reason/usage

## Developer docs

Detail teknis, struktur kode, protokol VSCode extension, cara menambah provider/tool, dan internal rendering di [DEVELOPMENT.md](DEVELOPMENT.md).
