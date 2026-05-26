# Siberflow

AI platform dengan dukungan multi-provider, tool calling streaming, sandbox file, dan persistensi multi-session. Interface saat ini: CLI. Web & VSCode extension menyusul.

## Provider yang didukung

- `deepseek` (default) — `deepseek-chat`, `deepseek-reasoner`
- `gemini` — `gemini-2.5-flash` (via endpoint OpenAI-compatible Google)
- `openai` — `gpt-5.4-nano` (pakai `/v1/chat/completions`)
- `openai-responses` — `gpt-5.1-codex-mini` (pakai `/v1/responses`; untuk codex / o-series / gpt-5 yang tidak didukung chat completions)

## Struktur

npm workspaces monorepo.

- `packages/core` — agent loop, provider adapter, tool registry, session store
- `packages/cli` — REPL interaktif

## Quick start (dev)

```bash
npm install
cp .env.example .env
# isi minimal salah satu API key: DEEPSEEK_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY

npm run dev:cli
```

## Install global (Ubuntu / macOS)

Prasyarat: Node 20+. Setelah clone repo:

```bash
npm install
npm run build
npm link -w @siberflow/cli
```

Sekarang `siberflow` bisa dipanggil dari direktori manapun. CLI mencari `.env` dengan walk-up dari cwd — jadi taruh `.env` di project tempat kamu kerja, atau export env vars di `~/.bashrc`:

```bash
export DEEPSEEK_API_KEY=...
export SIBERFLOW_PROVIDER=deepseek
```

Uninstall: `npm unlink -w @siberflow/cli`.

**Catatan:** `npm link` membuat symlink ke folder repo. Jangan pindah/hapus repo setelah link, atau command akan rusak. Untuk install benar-benar terpisah (repo bisa dihapus), perlu setup bundle dengan esbuild — bisa ditambahkan nanti kalau dibutuhkan.

Saat startup, CLI menampilkan daftar sesi tersimpan untuk project ini dan minta dipilih (atau dibuat baru dengan nama).

## Developer docs

Detail teknis, struktur kode, cara menambah provider/tool, dan internal CLI rendering ada di [DEVELOPMENT.md](DEVELOPMENT.md).
