# Siberflow

Siberflow is an AI coding and productivity platform with multi-provider support, streaming tool calls, sandboxed file access, database tools, persistent multi-session history, and task checklists. Current interfaces: **CLI**, **VS Code extension** sidebar, **Desktop app** built with Electron and React, and a **Telegram bot**.

[Baca versi Bahasa Indonesia](README.id.md)

Siberflow is developed by **DataSiberLab**. For questions, collaboration, or technical support, contact **candrapwr@datasiber.com**.

## Screenshots

**Desktop app - main chat workspace.** The desktop UI includes a multi-session sidebar, centered chat area, composer, and project-aware workspace context.

![Siberflow Desktop App](./ss_desktop.png)

**Desktop settings - provider and agent configuration.** Users can choose a provider, store an API key, configure a custom OpenAI-compatible provider, select models, toggle tools, and adjust agent behavior.

![Siberflow Desktop Settings](./ss_desktop_seting.png)

**Desktop ask tool - agent confirmation/input prompt.** This modal appears when the agent needs a user decision or extra input before continuing.

![Siberflow Desktop Ask Tool](./ss_desktop_ask_tool.png)

**VS Code extension - AI chat inside the editor sidebar.** The extension runs from the current workspace context.

![Siberflow VSCode Extension](./ss_vscode.png)

**CLI - interactive terminal mode.** Siberflow can also run as a terminal REPL.

![Siberflow CLI](./ss_cli.png)

## Supported Providers

- `deepseek` (default) - `deepseek-v4-flash`, `deepseek-reasoner`
- `gemini` - `gemini-2.5-flash` through Google's OpenAI-compatible endpoint
- `openai` - `gpt-5.4-nano` using `/v1/chat/completions`
- `openai-responses` - `gpt-5.1-codex-mini` using `/v1/responses`, for Codex/o-series/GPT-5 models that do not support chat completions
- `grok` - `grok-build-0.1` through xAI's OpenAI-compatible endpoint
- `qwen` - `qwen3.7-plus` through Alibaba DashScope/MaaS, OpenAI-compatible. Custom MaaS workspaces can override `SIBERFLOW_BASE_URL`
- `zai` - `glm-5.2` through Z.AI/GLM, OpenAI-compatible. Defaults to `https://api.z.ai/api/paas/v4`; GLM Coding endpoints can override `SIBERFLOW_BASE_URL`
- `claude` - `claude-sonnet-4-5` through Anthropic's OpenAI-compatible chat completions endpoint
- `custom` - any OpenAI-compatible provider with your own name, base URL, and default model. Available in Desktop, VS Code, and CLI

## Repository Structure

This is an npm workspaces monorepo.

- `packages/core` - agent loop, provider adapters, tool registry, file/database tools, session store, context optimization, task state
- `packages/cli` - interactive REPL, slash commands, ASCII banner, streaming renderer
- `packages/vscode-ext` - VS Code extension with sidebar chat panel, settings UI, markdown rendering
- `packages/desktop` - Electron desktop app with React/Vite, standalone UI, multi-session sidebar, safeStorage API keys
- `packages/telegram` - Telegram Bot API long-polling host with one Siberflow session and workdir per chat/thread

All sessions are stored in `~/.siberflow/sessions/` and are compatible across CLI, VS Code, Desktop, and Telegram.

## CLI

### Quick Start

```bash
npm install
cp .env.example .env
# Fill at least one API key:
# DEEPSEEK_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / XAI_API_KEY
# DASHSCOPE_API_KEY / ZAI_API_KEY / ANTHROPIC_API_KEY / CUSTOM_API_KEY

npm run dev:cli
```

### Custom Provider

Use `provider=custom` for any provider that supports the OpenAI `/chat/completions` wire format, such as an internal proxy, OpenRouter-compatible endpoint, vLLM, LiteLLM, or your own server.

In **Desktop** and **VS Code**, select `custom (OpenAI-compatible)` in settings, then fill:

- **Custom provider name** - display/internal name, for example `openrouter` or `local-vllm`
- **Base URL** - API root, for example `https://api.example.com/v1`; Siberflow appends `/chat/completions`
- **Default model** - model used when model override is empty
- **API key** - stored encrypted like built-in providers

For **CLI**, use environment variables:

```bash
SIBERFLOW_PROVIDER=custom
CUSTOM_API_KEY=...
SIBERFLOW_BASE_URL=https://api.example.com/v1
SIBERFLOW_CUSTOM_DEFAULT_MODEL=model-name
# optional:
SIBERFLOW_CUSTOM_PROVIDER_NAME=my-provider
```

`SIBERFLOW_MODEL` can also be used when you want an explicit model override. Do not include `/chat/completions` in `SIBERFLOW_BASE_URL`; use the API root, such as `/v1`.

### Global Install

Prerequisite: Node.js 20+. After cloning the repository:

```bash
npm install
npm run build
npm link -w @siberflow/cli
```

The `siberflow` command is now available from any directory. The CLI searches for `.env` by walking upward from the current working directory, so place `.env` in the project you are working on or export environment variables from your shell profile.

Uninstall:

```bash
npm unlink -w @siberflow/cli
```

`npm link` creates a symlink to this repository, so do not move or delete the repo after linking.

## Telegram Bot

The Telegram host runs Siberflow through Bot API long polling. Each private chat, group, supergroup, and forum thread gets its own persistent Siberflow session and its own workspace directory under `~/.siberflow/telegram-workdirs` by default.

Telegram provider/model can be overridden with `SIBERFLOW_TELEGRAM_PROVIDER` and `SIBERFLOW_TELEGRAM_MODEL`. API keys are still read from the provider's global key env. Telegram tools are controlled through `SIBERFLOW_TELEGRAM_TOOLS`; the default is `run_browser`.

```bash
npm install
cp .env.example .env

# Required:
TELEGRAM_BOT_TOKEN=...
DEEPSEEK_API_KEY=... # or another provider key selected by SIBERFLOW_PROVIDER

npm run dev:telegram
```

Optional Telegram-specific environment variables:

```bash
TELEGRAM_API_BASE_URL=https://api.telegram.org
SIBERFLOW_TELEGRAM_WORKDIR_ROOT=~/.siberflow/telegram-workdirs
SIBERFLOW_TELEGRAM_PROVIDER=deepseek
SIBERFLOW_TELEGRAM_MODEL=deepseek-v4-flash
SIBERFLOW_TELEGRAM_TOOLS=run_browser
```

Streaming behavior:

- Private chats use Telegram Bot API `sendRichMessageDraft` while the model streams, then persist the final response with `sendRichMessage`.
- Groups and supergroups receive the final `sendRichMessage` only, because Telegram rich message drafts are scoped to private chats.
- The bot does not use `editMessageText` or other message-edit APIs for streaming.

Commands:

- `/start` - short bot introduction
- `/reset` - delete the current Telegram chat/thread session
- `/siberflow <message>` - optional explicit prefix in groups

## VS Code Extension

### Development Mode

```bash
npm install
cd packages/vscode-ext
code .       # open in VS Code, then press F5
```

The Extension Development Host opens and the Siberflow icon appears in the left activity bar.

On first use, the settings panel asks for provider and API key. API keys are stored in **VS Code SecretStorage** and do not require `.env`.

For your own provider, select `custom (OpenAI-compatible)` and fill provider name, base URL, default model, and API key.

### Build a VSIX

From the repository root:

```bash
npm run package:vscode
# -> packages/vscode-ext/siberflow-chat-0.1.0.vsix
```

Install the `.vsix` in another VS Code installation:

- **GUI**: Cmd+Shift+P -> **Extensions: Install from VSIX...** -> select the file
- **CLI**: `code --install-extension siberflow-chat-0.1.0.vsix`

The VSIX is self-contained because esbuild bundles `@siberflow/core` and `marked`.

To release a new VSIX, update `version` in `packages/vscode-ext/package.json`, then run `npm run package:vscode` again.

## Desktop App

The desktop app is a standalone Electron app with a React/Vite UI. It consumes `@siberflow/core` directly, so the same agent, tools, and session logic are reused.

### Development Mode

```bash
npm run build:core
npm run dev:desktop
```

On first launch, the settings modal asks for provider and API key. API keys are stored through Electron **safeStorage** in the OS keychain-backed file at `~/Library/Application Support/Siberflow/siberflow-keys.json`.

Custom providers can be added from the settings modal by selecting `custom (OpenAI-compatible)`. Fill the API root base URL and default model; Siberflow uses `/chat/completions`.

If Electron did not download during `npm install`, run:

```bash
node node_modules/electron/install.js
```

### Build Installers

```bash
npm run package:desktop       # build + package for the current platform
npm run package:mac           # macOS (.dmg)
npm run package:win           # Windows (.exe / NSIS)
npm run package:linux         # Linux (.AppImage)
```

These scripts can be run from the repository root or from `packages/desktop`. Native modules (`ssh2`, `sqlite3`) are rebuilt for the Electron ABI through `electron-builder install-app-deps` inside the package scripts.

Output example: `packages/desktop/dist/Siberflow-<version>-<arch>.dmg`.

On Windows, if `npm run package:win` fails with `electron-builder is not recognized` or `app-builder.exe ENOENT`, force-install the builder binaries:

```powershell
npm install electron-builder@25 --force
npm install app-builder-bin --force
npm run package:win
```

For full Windows build notes, including Python and Visual Studio Build Tools prerequisites, see [BUILD-WINDOWS.md](BUILD-WINDOWS.md).

### Cross-Platform Build Limit

Desktop installers should be built on the target OS. Cross-compiling from one OS to another can produce installers that build successfully but crash at runtime because native modules are compiled for the wrong platform.

| Build host | macOS `.dmg` | Windows `.exe` | Linux `.AppImage` |
|---|---|---|---|
| **macOS** | Works | May build but app can crash | May build but app can crash |
| **Windows** | May build but app can crash | Works | May build but app can crash |
| **Linux** | May build but app can crash | May build but app can crash | Works |

Recommended options:

1. Build on the target OS.
2. Use GitHub Actions with `windows-latest`, `ubuntu-latest`, and `macos-latest`.
3. Use a Windows/Linux virtual machine when building from macOS.

Linux build prerequisites:

```bash
sudo apt update
sudo apt install -y build-essential python3 make g++
sudo apt install -y libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xauth \
  libatspi2.0-0 libdrm2 libgbm1 libasound2
```

If `npm install` times out while downloading Electron/electron-builder binaries, install first and rebuild manually:

```bash
npm install
cd packages/desktop && npm run rebuild
```

### Desktop Features

- **Multi-session sidebar** - chats grouped by project folder, switch/new/delete, inline rename
- **Folder picker** - each chat session can be tied to a project folder for file and shell sandboxing
- **Centered layout** - readable chat/composer width with a floating task panel
- **Resizable sidebar** - drag the right border to resize
- **App branding** - app name, icons, and window title

## Feature Summary

- **Streaming responses** - tokens render in real time with markdown support
- **File and shell tools** - `read_file`, `write_file`, `edit_file`, `copy_file`, `list_dir`, `exec`
- **Database query tool** - `db_query` supports MySQL, PostgreSQL, and SQLite
- **Excel spreadsheet tool** - `excel_script` can read, modify, and create `.xlsx` files through `exceljs`
- **Word document tool** - `docx_script` can create and read `.docx` files through `docx` and `mammoth`
- **PDF document tool** - `pdf_script` can create PDFs with `pdf-lib` and read digital text layers with `pdfjs-dist`
- **Browser tool** - `run_browser` automates installed Chrome/Edge through Puppeteer; no Chromium download
- **Image analysis tool** - `analyze_image` sends an image plus prompt to a configured OpenAI-compatible multimodal model
- **Per-tool toggle** - enable only the tools you need through settings or `SIBERFLOW_TOOLS`
- **Request delay** - `SIBERFLOW_REQUEST_DELAY_MS`, default `1500`, helps avoid provider rate limits
- **Task checklist** - resumable multi-step task state
- **Context optimization** - compacts old tool history with `recent`, `summary`, or `drop` modes
- **Auto-continue** - automatically continues responses cut off by max token limits
- **Silent task updates** - `task_update` runs without cluttering the transcript
- **Document upload from chat** - Desktop and VS Code can upload `.xlsx`, `.docx`, and `.pdf` into a per-session temporary directory
- **Multi-session persistence** - sessions are stored per project and can be resumed across interfaces
- **Debug tracing** - `SIBERFLOW_DEBUG=true` logs provider request/stream details
- **Custom provider** - Desktop, VS Code, and CLI can use any OpenAI-compatible provider via `custom`

## Document Tools

### Excel (`excel_script`)

`excel_script` uses `exceljs` in a locked-down `node:vm` sandbox. The agent supplies a synchronous JavaScript function `(wb, ExcelJS) => { ... return data }`; the host performs all file I/O.

Supported operations:

- **Read existing** - pass `path` and `readOnly: true`; returned data is serialized back to the agent
- **Modify existing** - pass `path`; the workbook is loaded, mutated, then written back to `path` or `saveAs`
- **Create new** - omit `path`, build worksheets from scratch, and pass `saveAs`

The tool supports formulas, images exposed through `exceljs`, styling, merges, tables, filters, validation, and other `exceljs` APIs.

### Word (`docx_script`)

`docx_script` uses `docx` for creation and `mammoth` for reading. Create mode receives `(doc, docx)` and writes a generated document through `Packer.toBuffer`. Read mode converts `.docx` to HTML with mammoth and passes that HTML to a synchronous script.

It supports headings, paragraphs, text styling, bullets/numbering, tables, sections, headers/footers, and image insertion when bytes are supplied by another tool.

### PDF (`pdf_script`)

`pdf_script` uses `pdf-lib` for creation and `pdfjs-dist` for reading. Create mode receives `(pdf, P, font)` with a pre-embedded Helvetica font. Read mode extracts digital text layers from pages and joins pages with `\f`.

Scanned/image-only PDFs do not return text because OCR is not included.

### Uploads

Desktop and VS Code copy uploaded documents into:

```text
os.tmpdir()/siberflow-uploads/<sessionId>/
```

Only document tools are allowed to read that upload directory through `ToolContext.uploadDir`; normal file/shell tools remain sandboxed to the project directory.

## Browser Tool (`run_browser`)

`run_browser` executes Puppeteer scripts in an isolated child-process worker. It uses installed Chrome or Edge (`chrome`, then `msedge`) and has a timeout kill path. Output is capped to keep prompts manageable.

Enable it through settings in Desktop/VS Code or through `SIBERFLOW_TOOLS` in CLI.

## Image Analysis Tool (`analyze_image`)

`analyze_image` accepts a local image path, HTTP(S) image URL, or `data:image/...` URL plus a prompt. Local paths are sandboxed to the session project/workdir or upload directory.

Configure the multimodal OpenAI-compatible provider:

```bash
SIBERFLOW_MULTIMODAL_BASE_URL=https://api.openai.com/v1
SIBERFLOW_MULTIMODAL_MODEL=gpt-4o-mini
SIBERFLOW_MULTIMODAL_API_KEY=...
```

Enable it through settings or env, for example:

```bash
SIBERFLOW_TELEGRAM_TOOLS=run_browser,analyze_image
```

## Per-Tool Toggle

Default enabled tools are only:

```text
read_file,write_file,edit_file,copy_file,list_dir
```

Other tools such as `exec`, `db_query`, `ssh_exec`, `sftp`, `excel_script`, `docx_script`, `pdf_script`, `run_browser`, and `analyze_image` are opt-in. `task_update` and `ask_user` are core UX tools and are always available.

| Interface | How to configure |
|---|---|
| **CLI** | `SIBERFLOW_TOOLS=read_file,write_file,edit_file,copy_file,list_dir,run_browser` |
| **VS Code** | `siberflow.enabledTools` plus the settings UI checkbox grid |
| **Desktop** | Settings modal -> Tools |

## Developer Docs

For technical architecture, VS Code protocol details, provider/tool development, packaging notes, and renderer internals, see [DEVELOPMENT.md](DEVELOPMENT.md).
