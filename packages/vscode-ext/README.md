# Siberflow

AI chat sidebar untuk VSCode. Multi-provider (DeepSeek, Gemini, OpenAI, xAI Grok), tool calling sandboxed, task checklist, session persistence.

## Fitur

- **Sidebar chat panel** — icon Siberflow di activity bar, klik untuk buka
- **Streaming response** dengan markdown rendering
- **Tool calling** — `read_file`, `write_file`, `edit_file`, `copy_file`, `list_dir`, `exec` — semua sandboxed ke workspace folder
- **Task checklist** opt-in — AI maintain progress checklist multi-step yang survive Ctrl+C dan restart
- **Context optimization** — buang tool noise turn lama
- **Auto-continue** — sambung otomatis respons yang kepotong max_tokens
- **Multi-session** — sesi tersimpan di `~/.siberflow/sessions/` per project
- **API key** encrypted via VSCode SecretStorage — tidak perlu `.env`
- **Cross-compat** dengan CLI Siberflow — sesi yang dibuat di CLI bisa di-load di VSCode dan sebaliknya

## Penggunaan

1. Klik icon Siberflow di activity bar kiri
2. Pertama kali: settings panel auto-muncul minta API key + provider
3. Pilih atau buat sesi → mulai chat

## Konfigurasi

Buka panel settings via tombol ⚙ di topbar, atau VSCode preferences → cari "Siberflow":

| Setting | Default | Keterangan |
|---|---|---|
| `siberflow.provider` | `deepseek` | `deepseek` / `gemini` / `openai` / `openai-responses` / `grok` |
| `siberflow.model` | (provider default) | Override model — kosong = default tiap provider |
| `siberflow.tasks` | **`true`** | Aktifkan task checklist tool |
| `siberflow.contextOptimize` | **`true`** | Buang tool history turn lama |
| `siberflow.autoContinue` | `true` | Auto-sambung respons kepotong |
| `siberflow.hideTools` | **`true`** | Sembunyikan detail tool call (spinner only) |
| `siberflow.maxIterations` | `50` | Batas tool loop per turn |
| `siberflow.debug` | `false` | Verbose logging ke stderr |

> Empat opsi default ON di VSCode (tasks, optimize, hideTools, autoContinue) untuk UX terbaik out-of-the-box. Bisa di-disable per kebutuhan via settings panel.

## Requirements

- VSCode 1.85+
- Workspace folder terbuka (untuk sandbox tools)
- API key dari provider yang dipakai

## Repository

[github.com/candrapwr/siberflow](https://github.com/candrapwr/siberflow)
