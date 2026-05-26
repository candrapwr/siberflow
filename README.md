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

## Quick start

```bash
npm install
cp .env.example .env
# isi minimal salah satu API key: DEEPSEEK_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY

npm run dev:cli
```

Saat startup, CLI menampilkan daftar sesi yang tersimpan untuk project ini dan minta dipilih (atau dibuat baru dengan nama).

## Developer docs

Detail teknis, struktur kode, cara menambah provider/tool, dan internal CLI rendering ada di [DEVELOPMENT.md](DEVELOPMENT.md).
