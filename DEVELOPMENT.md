# Siberflow — Developer Reference

Referensi teknis untuk developer yang akan memperluas atau memodifikasi siberflow.

Stack: TypeScript (ESM, NodeNext), Node 20+, npm workspaces.

Runtime dependencies di `@siberflow/core` saat ini:
- `mysql2` untuk MySQL
- `pg` untuk PostgreSQL
- `sqlite3` untuk SQLite

## Repository

```
siberflow/
├── package.json              # workspaces root; build script chains core → cli → vscode-ext
├── tsconfig.base.json        # shared strict TS config + types:[node]
├── .env.example
└── packages/
    ├── core/                 # @siberflow/core (composite TS project)
    │   └── src/
    │       ├── agent/
    │       │   ├── types.ts       # Message, ToolCall, StreamEvent, FinishReason
    │       │   ├── agent.ts       # class Agent — streaming loop
    │       │   ├── optimize.ts    # optimizeContext() — Layer 1 context compaction
    │       │   ├── prompts.ts     # buildSystemPrompt() — interface-aware system prompt
    │       │   └── tasks.ts       # Task, TaskStore, renderTaskList
    │       ├── providers/
    │       │   ├── base.ts        # interface Provider (chatStream only)
    │       │   ├── sse.ts         # parseSSE() — shared SSE parser
    │       │   ├── openai-compatible.ts  # base class untuk /chat/completions style
    │       │   ├── deepseek.ts    # extends OpenAICompatibleProvider
    │       │   ├── gemini.ts      # extends OpenAICompatibleProvider
    │       │   ├── grok.ts        # extends OpenAICompatibleProvider (xAI)
    │       │   ├── openai.ts      # extends OpenAICompatibleProvider (/v1/chat/completions)
    │       │   ├── openai-responses.ts   # standalone — OpenAI /v1/responses API
    │       │   ├── qwen.ts        # extends OpenAICompatibleProvider (Alibaba DashScope/MaaS)
    │       │   ├── zai.ts         # extends OpenAICompatibleProvider (Z.AI / GLM)
    │       │   ├── claude.ts      # extends OpenAICompatibleProvider (Anthropic OpenAI-compat)
    │       │   └── registry.ts    # createProvider(name, config)
    │       ├── tools/
    │       │   ├── base.ts        # interface Tool, ToolContext { projectDir, uploadDir? }
    │       │   ├── registry.ts    # class ToolRegistry
    │       │   ├── file/
    │       │   │   ├── path-utils.ts # resolveWithin() — sandbox resolver
    │       │   │   ├── read.ts | write.ts | edit.ts | copy.ts | list.ts
    │       │   │   └── index.ts   # fileTools[]
    │       │   ├── db/
    │       │   │   ├── query.ts   # db_query — MySQL / PostgreSQL / SQLite
    │       │   │   └── index.ts   # dbTools[]
    │       │   ├── cli/
    │       │   │   ├── exec.ts    # shell exec, cwd=projectDir
    │       │   │   └── index.ts
  │       │   ├── excel/
  │       │   │   ├── read.ts    # read_excel — multi-sheet, table/json output
  │       │   │   ├── write.ts   # write_excel — multi-sheet, styled output
  │       │   │   ├── script.ts  # write_excel_script — full exceljs API via vm sandbox
  │       │   │   ├── styles.ts  # theme presets, named colors, number formats
  │       │   │   └── index.ts   # excelTools[]
  │       │   ├── ssh/
  │       │   │   ├── exec.ts    # ssh_exec — remote shell over SSH2
  │       │   │   ├── sftp.ts    # sftp — remote file transfer
  │       │   │   └── index.ts
  │       │   ├── browser/
  │       │   │   ├── browser.ts # run_browser — headless Chrome/Edge via Puppeteer (child_process worker)
  │       │   │   └── index.ts   # browserTools[]
  │       │   ├── interaction/
  │       │   │   ├── ask-user.ts # ask_user — modal prompt ke user (always-on)
  │       │   │   └── index.ts
  │       │   ├── task/
  │       │   │   ├── update.ts  # task_update tool (always-on)
  │       │   │   └── index.ts
  │       │   └── index.ts       # createDefaultRegistry({ tasks?, filesystem?, enabledTools? })
    │       ├── session/
    │       │   ├── types.ts       # Session, SessionSummary, SESSION_FORMAT_VERSION
    │       │   └── store.ts       # save/load/list/delete/clear + uploadsDirFor/cleanupUploads
    │       ├── config/index.ts    # loadConfigFromEnv()
    │       └── index.ts           # re-exports
    ├── cli/                  # @siberflow/cli (references core)
    │   ├── bin/siberflow.js  # shim → dist/index.js
    │   └── src/
    │       ├── index.ts           # entry: load env, build deps, runRepl()
    │       ├── env.ts             # .env loader (walk-up, no deps)
    │       ├── repl.ts            # session picker + main loop + slash commands
    │       ├── markdown.ts        # MarkdownStreamer (renderLine for live reformat)
    │       ├── tool-renderer.ts   # ToolCallRenderer (raw arg streaming)
    │       ├── spinner.ts         # Spinner (loading animation, TTY-only)
    │       └── ui.ts              # ANSI colors + splashBanner + helpers
    ├── vscode-ext/           # siberflow-chat (sidebar webview, bundled by esbuild)
    │   ├── package.json      # manifest: viewsContainer, view, commands, settings
    │   ├── resources/icon.svg          # activity bar icon
    │   ├── esbuild.config.mjs          # bundles extension (cjs) + webview (iife)
    │   ├── src/
    │   │   ├── extension.ts            # activate(): register WebviewViewProvider + commands
    │   │   ├── chat-panel.ts           # ChatViewProvider — agent + session + settings lifecycle
    │   │   └── protocol.ts             # ExtToView / ViewToExt message types
    │   └── webview/
    │       └── main.ts                 # webview-side: topbar, popovers, messages, composer
    └── desktop/              # siberflow-desktop (Electron + React + Vite)
        ├── package.json              # electron, electron-vite, electron-builder, react
        ├── electron.vite.config.ts   # vite config (main + preload + renderer)
        ├── electron-builder.yml      # installer config (dmg/nsis/AppImage)
        ├── resources/                # app icons (.icns/.ico/.png + source .svg)
        └── src/
            ├── shared/protocol.ts    # MainEvent / RendererCalls typed IPC contract
            ├── main/
            │   ├── index.ts          # Electron entry: BrowserWindow, app lifecycle
            │   ├── agent-host.ts     # Agent lifecycle + turn runner (mirrors chat-panel.ts)
            │   ├── ipc.ts            # ipcMain handlers (typed)
            │   ├── secrets.ts        # safeStorage wrapper untuk API keys
            │   └── settings.ts       # JSON settings store di userData
            ├── preload/
            │   └── index.ts          # contextBridge — expose window.siberflow
            └── renderer/
                ├── index.html        # Vite entry
                ├── main.tsx          # React root
                ├── App.tsx           # layout (sidebar + chat + modals)
                ├── ipc.ts            # typed wrapper window.siberflow
                ├── components/       # Sidebar, ChatView, Message, Composer, TaskPanel, ...
                ├── hooks/            # useChat (streaming reducer), useSessions
                └── styles/global.css # design system (flat, dark)
```

## Inti

### Message format

Internal netral provider. Provider adapter yang menerjemahkan ke/dari format wire.

```ts
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

interface ToolCall {
  id: string;
  name: string;
  arguments: string;  // raw JSON string; tool parses sendiri
}
```

### StreamEvent

Output `Provider.chatStream(req)` — `AsyncIterable<StreamEvent>`.

```ts
type StreamEvent =
  | { type: "content"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | { type: "done"; message: AssistantMessage; finishReason: FinishReason; usage?: UsageStats };
```

Provider memanggil event dalam urutan: `content` & `tool_call_*` (interleaved, sesuai stream), lalu `done` terakhir. `tool_call_start` emit sekali per index saat `id` + `name` pertama lengkap; `tool_call_args` emit per delta JSON. `done.message` adalah pesan ter-assemble lengkap (sudah ada semua tool calls dari accumulator).

### Provider interface

```ts
interface Provider {
  readonly name: string;
  readonly defaultModel: string;
  chatStream(req: ChatRequest): AsyncIterable<StreamEvent>;
}
```

Ada dua keluarga provider:

**1. OpenAI Chat Completions style** — [openai-compatible.ts](packages/core/src/providers/openai-compatible.ts) sebagai base. Cocok untuk endpoint `/chat/completions` dengan SSE events `data: {choices: [{delta: ...}]}`. Subclass: `DeepSeekProvider`, `GeminiProvider`, `OpenAIProvider` — masing-masing cuma override `name`, `defaultModel`, `defaultBaseUrl`.

Base class menangani:
1. Konversi `Message[]` → format OpenAI chat completions
2. POST dengan `stream: true` + optional `stream_options.include_usage`
3. SSE parser (dari [sse.ts](packages/core/src/providers/sse.ts))
4. Akumulasi tool_call deltas di `Map<index, ToolCall>`
5. Emit `StreamEvent` ke iterator

**2. OpenAI Responses API** — [openai-responses.ts](packages/core/src/providers/openai-responses.ts) standalone, implement `Provider` langsung. Untuk model yang OpenAI tolak di `/chat/completions` (codex, sebagian o-series, gpt-5 tertentu). Perbedaan dari chat completions:

- Endpoint `/v1/responses`
- Request pakai `input` (array of items) bukan `messages`
- Assistant + tool calls dipecah jadi `function_call` items + `function_call_output`
- Tool definition flat (`{type, name, description, parameters}`) tanpa wrapper `function`
- SSE events bertype `response.output_text.delta`, `response.output_item.added`, `response.function_call_arguments.delta`, `response.completed`

Mapping ke `StreamEvent` di kode masing-masing provider — interface eksternal tetap sama.

[sse.ts](packages/core/src/providers/sse.ts) berisi `parseSSE(body): AsyncIterable<unknown>` yang dipakai kedua keluarga.

### Tool interface

```ts
interface Tool {
  readonly name: string;             // snake_case
  readonly description: string;      // ditulis untuk LLM
  readonly parameters: Record<string, unknown>;  // JSON Schema
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

interface ToolContext {
  projectDir: string;   // sandbox root untuk semua tool file
  uploadDir?: string;   // tmp upload dir, HANYA dibaca read_excel (lihat section Excel)
  taskStore?: TaskStore;  // hadir saat tasksEnabled
}
```

Tool return string yang akan dikirim balik ke LLM sebagai `tool` message content. Throw `Error` untuk kegagalan — `ToolRegistry.execute()` yang menangkap & convert ke "Error: ..." string.

Default registry saat ini memuat delapan kategori tool:
- file tools: `read_file`, `write_file`, `edit_file`, `copy_file`, `list_dir`
- cli tool: `exec`
- database tool: `db_query` (MySQL / PostgreSQL / SQLite)
- excel tools: `read_excel`, `write_excel`, `write_excel_script` (multi-sheet `.xlsx`, styled output + full exceljs API via vm sandbox)
- ssh tools: `ssh_exec` (remote shell via SSH2), `sftp` (remote file transfer)
- browser tool: `run_browser` (headless Chrome/Edge via Puppeteer, child_process worker)
- interaction tool: `ask_user` (modal prompt ke user di host UI — always-on)
- task tool: `task_update` (always-on — silent di semua interface, bypass enabledTools)

**Per-tool toggle (`enabledTools`)**: tool selain file ops default OFF — opt-in via settings/env supaya prompt ringan + blast-radius security kecil. File + cli + excel tools juga gated `filesystem: true` (butuh workdir). db / ssh / browser tools terdaftar tanpa workdir. `task_update` dan `ask_user` selalu ter-register (bypass `enabledTools`).

Default enabled: `read_file`, `write_file`, `edit_file`, `copy_file`, `list_dir` saja (`DEFAULT_ENABLED_TOOLS` di `tools/index.ts`). Enable lain via settings atau `SIBERFLOW_TOOLS` env (CLI).

### Database tool

Tool `db_query` memberi akses query SQL langsung ke:
- `mysql`
- `postgresql`
- `sqlite`

Schema argumen:
- Common: `engine`, `query`, optional `params`
- MySQL/PostgreSQL: `host`, `user`, `password`, `database`, optional `port`
- SQLite: `path`

Catatan implementasi:
- Tidak ada pembatasan jenis query; `SELECT`, `INSERT`, `UPDATE`, `DELETE`, DDL, dan syntax engine-specific tetap diteruskan ke driver masing-masing
- Output dikembalikan sebagai JSON string berisi ringkasan hasil (`rows`, `rowCount`, `command`, `changes`, `lastID`, dll sesuai engine)
- Hasil row dibatasi preview `200` row agar context tidak meledak
- SQLite path tetap lewat `resolveWithin()` sehingga file DB harus berada di dalam project directory
- `sqlite3` di-load secara lazy via dynamic `import()` hanya saat `engine="sqlite"` dipakai. Ini mencegah startup crash pada host yang tidak kompatibel dengan native binary SQLite
- Pada Linux dengan glibc lebih tua, MySQL/PostgreSQL tetap bisa dipakai walau SQLite gagal load. Error SQLite akan muncul saat tool dipanggil, bukan saat app boot
- Jika deployment Linux gagal dengan error `GLIBC_x.y not found` dari `node_sqlite3.node`, rebuild di mesin target: `npm rebuild sqlite3 --build-from-source`

Contoh argumen:

```json
{
  "engine": "mysql",
  "host": "127.0.0.1",
  "user": "root",
  "password": "secret",
  "database": "app_db",
  "query": "select id, email from users where status = ? limit 10",
  "params": ["active"]
}
```

```json
{
  "engine": "sqlite",
  "path": "data/app.db",
  "query": "update jobs set status = ? where id = ?",
  "params": ["done", 42]
}
```

### Excel tools

Domain `tools/excel/` pakai library `exceljs` (pure JavaScript, **tidak ada native addon** — aman untuk build Electron cross-platform, tidak perlu rebuild seperti `sqlite3`/`ssh2`). Dua tool:

**`read_excel`** — baca workbook `.xlsx`. Output default markdown `table` (header ditulis sekali) atau `json` (array row objects, presisi numerik terjaga). Bisa baca satu sheet spesifik (`sheet`) atau semua sheet sekaligus (tiap sheet di-prefix `=== Sheet: <name> (<rows> rows) ===`, sheet kosong di-skip). Tipe data dipertahankan: angka tetap number, tanggal → ISO string, formula → result, merged cell → value top-left, error cell (`#N/A`) → string. Safety caps: `maxRows` default 500 per sheet, total output 200K chars (sama seperti `db_query`).

Catatan implementasi penting:
- **ESM/CJS**: `exceljs` CommonJS; di NodeNext ESM named import gagal runtime → pakai `import ExcelJS from "exceljs"; const { Workbook } = ExcelJS`
- **Type mismatch Buffer**: exceljs pinned ke `@types/node` lama, `load(buffer)` structural mismatch → cast `as any` di call site (runtime aman)
- **Resolve path**: pakai `resolveExcelPath(ctx, path)` — bukan `resolveWithin` langsung. Cek upload dir dulu (kalau ada & path absolut), fallback ke project sandbox

**`write_excel`** — buat/overwrite workbook `.xlsx` multi-sheet dari map `sheets: { SheetName: [rowObjects] }`. Header diambil dari key object pertama. Default sudah styling rapi (theme `professional`: header bold + biru + text putih + freeze pane + autoWidth + zebra rows). Styling custom ramah AI (high-level, bukan raw exceljs style):
- `theme`: `professional` / `zebra` / `minimal` / `colorful`
- `header`: `{ bold?, background?, color? }` — warna pakai nama (`blue`/`lightgray`/25+ lainnya di `styles.ts`) atau hex `#RRGGBB`
- `zebraRows`, `freezeHeader`, `autoWidth` (toggle boolean)
- `numberFormats`: map kolom → named format (`currency`, `date`, `datetime`, `percent`, `integer`, `decimal`) atau format Excel custom string

Catatan implementasi:
- **Tanggal via JSON**: tool args datang sebagai JSON (Date → ISO string via `JSON.parse`). `coerceValue` deteksi strict ISO date-only / datetime → convert balik ke Date object supaya tersimpan sebagai date cell. Date-only `2025-01-01` parse sebagai **local midnight** (tidak geser TZ ke `07:00:00`); datetime dengan offset dipertahankan
- **Validation**: nama sheet max 31 char, no duplikat (case-insensitive), reject karakter `\ / ? * [ ] :`; reject file bukan `.xlsx`
- **write_excel tetap sandbox projectDir** — output Excel harus di project (berbeda dengan read_excel yang whitelist upload dir). resolve pakai `resolveWithin(ctx.projectDir, path)` langsung

Contoh argumen `write_excel`:

```json
{
  "path": "laporan.xlsx",
  "sheets": {
    "Penjualan": [
      { "produk": "Indomie", "qty": 10, "harga": 3000, "tanggal": "2025-01-01" },
      { "produk": "Aqua", "qty": 5, "harga": 5000, "tanggal": "2025-01-02" }
    ],
    "Stok": [
      { "produk": "Indomie", "stok": 200 }
    ]
  },
  "styling": {
    "theme": "colorful",
    "numberFormats": { "harga": "currency", "tanggal": "date" }
  }
}
```

### Upload Excel (UI Desktop & VSCode)

Fitur upload `.xlsx` dari composer (tombol paperclip) menyimpan file ke **OS tmp dir** — bukan project folder — supaya workspace bersih dan tidak ikut git.

- **Lokasi**: `os.tmpdir()/siberflow-uploads/<sessionId>/` (per-session isolated, `mkdir mode 0o700` → owner-only, mitigasi `/tmp` world-readable di Linux)
- **Alur**: tombol paperclip → native file picker `.xlsx` multi-select → `copyUploads(srcPaths)` salin ke upload dir (nama di-sanitize, collide → append `-2`) → return `{ name, relPath(absolute), bytes }[]` → renderer render chip attachment → saat send, prompt otomatis digabung dengan list path file + instruksi → AI pakai `read_excel`
- **Whitelist**: `read_excel` resolve path absolut via `ToolContext.uploadDir` (dari `AgentOptions.uploadDir`). Tool file lain (`read_file`, `write_file`, `exec`, dll) **tidak terima** `uploadDir` → tetap sandbox projectDir, tidak bisa baca tmp
- **Cleanup**: `deleteSession(id)` otomatis `cleanupUploads(id)` (rm recursive). Folder tmp juga di-reap OS saat reboot
- **Helper core**: `uploadsDirFor(sessionId)` + `cleanupUploads(sessionId)` di `session/store.ts`

### Path sandbox

Helper [resolveWithin](packages/core/src/tools/file/path-utils.ts):

```ts
async function resolveWithin(projectDir: string, p: string): Promise<string>
```

Algoritma:
1. Resolve `p` ke absolute (relative → relatif terhadap `projectDir`).
2. `realpath()` mengikuti symlink. Untuk file belum ada, traverse ke ancestor terdalam yang exist, lalu rangkai ulang.
3. `realpath(projectDir)` juga.
4. `path.relative(projectReal, targetReal)` — kalau mulai dengan `..` atau absolute → throw "outside project directory".

Setiap tool file (read/write/edit/copy/list) wajib lewat `resolveWithin` sebelum operasi fs.

`read_excel` adalah pengecualian: pakai `resolveExcelPath(ctx, path)` yang **cuma allow path absolut di dalam `ctx.uploadDir`** (tmp upload dir), lalu fallback ke `resolveWithin(ctx.projectDir, ...)`. Path relatif selalu resolve ke projectDir — tidak bisa nekat baca file upload lewat nama relatif. `write_excel` pakai `resolveWithin` biasa (output Excel harus di project).

### `write_excel_script` (full exceljs API via vm sandbox)

Untuk layout Excel kompleks (merge cells, multi-level header, conditional formatting, chart, autofilter, dll) yang gak bisa di-handle `write_excel` (data mode). AI tulis function JavaScript `(wb, ExcelJS) => { ... }` yang dijalankan di **sandbox `node:vm`** terkunci:

- Context cuma expose `wb` (workbook) + `ExcelJS` + minimal globals (Math/JSON/Date/dll)
- `require`/`process`/`fs`/`global`/`globalThis` di-shadow jadi `undefined`
- `codeGeneration: { strings: false, wasm: false }` disable `eval` + `Function` constructor
- Timeout 5 detik untuk infinite loop

**Pola worker** yang penting: compile + invoke script dalam **satu `runInContext`** call (embed script sebagai static source text dalam wrapper IIFE), BUKAN return function dari sandbox lalu invoke di host. Kalau di-invoke di host, timeout vm gak cover execution — infinite loop gak ke-kill (bug yang sudah di-fix). Lihat `tools/excel/script.ts` untuk pattern lengkap.

### Browser tool (`run_browser`)

Tool scraping/interaksi halaman web via **headless Chrome/Edge menggunakan Puppeteer**. Pakai dependency `puppeteer-core` (zero native deps; **tidak ada download Chromium** — pakai Chrome/Edge yang sudah terinstall di sistem user). Terdaftar di bucket network-only (sama seperti `db`/`ssh`) — gak butuh workdir.

**Cara kerja**:
1. Tool spawn **child process worker** via `fork()` — worker source di-embed sebagai string di `browser.ts`, ditulis ke `<tmpdir>/siberflow-browser-worker.mjs` saat runtime (supaya work di bundled CJS context yang gak punya `import.meta.url`)
2. Worker launch Chrome atau Edge headless (channel `'chrome'` → fallback `'msedge'`), `page.goto(url)` kalau ada, eval script Puppeteer AI-supplied `async ({page, browser}) => {...}`, kirim result via IPC `process.send(...)`
3. Host tunggu result atau kill worker via `killTree(pid)` (`process.kill(-pid)` Unix / `taskkill /T` Windows — reuse pattern dari `cli/exec.ts`)
4. Output di-truncate 200K chars

**Kenapa child_process, bukan vm sandbox?** Puppeteer async-only (`await page.goto()`). `vm.runInContext` sync dan blocking — gak bisa `await`. Timeout async code di vm unreliable (sudah di-alami di `write_excel_script` infinite loop). Child process isolation lebih clean: worker gak punya akses host memory/session/AgentHost; env minimal (PATH, HOME, dll); worst case script AI menulis kode malicious → worker crash/isolated → gak affect host.

**Resolved path** (`resolvePuppeteerCorePath()`): worker import `puppeteer-core` via absolute `file://` URL yang di-inject ke worker source. Worker di-run dari temp dir tanpa `node_modules`, jadi bare `import "puppeteer-core"` gak resolve. Resolution order di `browser.ts`:
1. Env var `SIBERFLOW_PUPPETEER_CORE_PATH` — override eksplisit dari host. Wajib di VSCode extension (process.execPath = VSCode binary, jadi heuristik core gak nemu). Host (`chat-panel.ts`) resolve path sendiri: cek `<extensionPath>/vendor/puppeteer-core` (VSIX packaged) → `<extensionPath>/node_modules/puppeteer-core` → walk-up parent dirs cari hoisted `node_modules/puppeteer-core` (debug mode).
2. `createRequire(cwd)` — CLI / dev / ESM install
3. `createRequire(import.meta.url)` — cwd-independent (packaged apps)
4. Manual scan candidate dirs (Electron `resourcesPath`, `execPath` dir)

**Packaging VSCode (penting)**: `vsce` meng-ignore seluruh `node_modules/` walau di-whitelist di `.vscodeignore`. Karena ini monorepo (npm workspaces), `puppeteer-core` ter-hoist ke root. Solusinya: script `scripts/stage-puppeteer.mjs` (hook `prepackage`/`postpackage`) copy `puppeteer-core` dari root ke `vendor/puppeteer-core` sebelum `vsce package`, hapus setelahnya. `chat-panel.ts` arahkan env var ke `<extensionPath>/vendor/puppeteer-core`.

### Per-tool toggle (`enabledTools`)

Tool selain file ops default OFF untuk prompt ringan + blast-radius security kecil. Filter di `createDefaultRegistry({ enabledTools: Set<string> })`:

- File + cli + excel tools: gated **keduanya** `hasFs && enabled.has(name)` — butuh workdir DAN user opt-in
- db + ssh + web tools: gated **hanya** `enabled.has(name)` — network tools, gak butuh workdir
- `task_update`: bypass `enabledTools`, gated `tasks` (master switch task checklist)

Default: `DEFAULT_ENABLED_TOOLS = { read_file, write_file, edit_file, copy_file, list_dir }`. Setting via:
- CLI: `SIBERFLOW_TOOLS=name1,name2` env (lihat `.env.example`)
- VSCode: setting `siberflow.enabledTools` (array) + grid checkbox di settings UI (`TOGGLE_TOOLS` const)
- Desktop: settings modal → section "Tools" (grid checkbox, sama pattern `TOGGLE_TOOLS`)

UI toggle conditional pattern: Composer upload button (paperclip) disable + tooltip saat `read_excel` tidak di-enable — cek `state.enabledTools.includes("read_excel")`. Sama untuk tool UI lain yang depend availability.

### Request delay (`requestDelayMs`)

Jeda sebelum setiap request ke LLM, anti rate-limit saat loop tool-call cepat. Diterapkan di **satu titik**: `runStream()` di `agent/agent.ts` (titik tunggal tempat `provider.chatStream()` dipanggil — otomatis throttle initial + auto-continue + tool-call iteration). Abortable: `sleep(ms, signal)` listen `AbortSignal` → reject `AbortError` → turn rollback (history + tasks).

Default 1500ms (config layer + `DEFAULT_SETTINGS`), 0 di core level. Setting:
- CLI: `SIBERFLOW_REQUEST_DELAY_MS` env
- VSCode/Desktop: settings UI field "Request delay (ms)"

Tool `exec` cwd-nya `projectDir`, tapi shell command bisa secara teknis akses path lain (`$HOME`, `cd /tmp`, dll). Sandbox keras hanya untuk file tools. Untuk hard isolation perlu container.

### Agent loop

[agent.ts](packages/core/src/agent/agent.ts) — class `Agent`:

```
send(userInput, events):
  messages.push({ role: "user", content: userInput })
  for i in 0..maxIterations:
    events.onAssistantStart()
    for await ev of provider.chatStream({ model, messages, tools: registry }):
      switch ev.type:
        content         → events.onContent(ev.delta)
        tool_call_start → events.onToolCallStart(ev.index, ev.name)
        tool_call_args  → events.onToolCallArgs(ev.index, ev.delta)
        done            → capture { assistant, finishReason, usage }
    messages.push(assistant)
    events.onAssistantEnd(assistant, { finishReason, usage })

    if finishReason !== "tool_calls": return assistant.content
    for (idx, call) in assistant.toolCalls:
      result = registry.execute(call.name, call.arguments, ctx)
      events.onToolResult(idx, call.name, result)
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result })
```

Method tambahan:
- `loadHistory(messages)` — restore dari session
- `reset()` — hapus history tapi pertahankan system prompt
- `history()` — read-only akses

`maxIterations` default 50 (via `SIBERFLOW_MAX_ITERATIONS`), mencegah infinite tool loop. Saat cap tercapai tanpa jawaban final, emit `onMaxIterations(limit)` → CLI tampilkan notice "ketik lanjutkan". Dengan task checklist aktif, melanjutkan akan resume dari item pending (state ter-reinject).

### Auto-continue (output kepotong)

Default ON (`SIBERFLOW_AUTO_CONTINUE`, set `false` untuk matikan). Saat satu LLM call selesai dengan `finishReason="length"` (output kena `max_output_tokens`) dan **tanpa** tool call, Agent otomatis menyambung:

1. Bangun request ephemeral: `requestMessages + assistant(partial) + user(CONTINUE_NUDGE)`
2. Stream lanjutan, gabungkan content ke assistant yang sama
3. Ulangi sampai `finishReason !== "length"` atau cap `MAX_AUTO_CONTINUES` (4)

Penting:
- Request continuation **ephemeral** — synthetic user nudge TIDAK masuk history. Hanya **satu** assistant message hasil merge yang disimpan.
- Streaming tetap mengalir mulus ke user (onContent dari tiap segmen).
- Logika di-encapsulate di `runStream()` (konsumsi satu chatStream) + loop continuation di `send()`.

Ini mengatasi respons panjang yang terpotong di tengah kalimat. Untuk masalah context-window overflow (beda dari output-length), lihat catatan di akhir bagian Context optimization.

### Context optimization (Layer 1)

[optimize.ts](packages/core/src/agent/optimize.ts) → `optimizeContext(messages, config)` membuang jejak tool dari turn sebelumnya supaya context tetap ramping. Returns array baru; input tidak di-mutasi.

**Tiga mode** (`OptimizeMode`), via `SIBERFLOW_CONTEXT_OPTIMIZE_MODE`:

- **`recent`** (default) — sisakan signature `[SUMMARY]` pada turn-turn lama, TAPI pertahankan **1 turn terakhir sebelum current turn tetap utuh** (tool calls + results verbatim). Hanya turn yang lebih tua dari itu dikompres. Tujuannya: konteks tool terakhir tidak hilang dulu — penting untuk workflow trial-and-error seperti `run_browser` (AI iterasi script sampai dapat yang pas, lalu pakai di turn berikutnya).
  - Logika: cari index **second-to-last user message** (user terakhir = current turn yang sedang jalan). Semua pesan sebelumnya dikompres via mode `summary`; dari index itu sampai akhir dibiarkan utuh. Kalau user message < 2 (turn 1 atau 2) → tidak ada yang eligible → tidak ada kompresi.
- **`summary`** — sisakan tag `[SUMMARY]` breadcrumb pada **setiap** turn lama, berisi *signature* tool per call (nama + identifier ringkas seperti `exec("df -h")` / `write_file("src/foo.ts")`). Payload berat (file content, edit patch, task list) dan tool result tetap dibuang. Model tahu APA yang disentuh tanpa leak nilai stale.
- **`drop`** — buang tool activity total tanpa breadcrumb (paling hemat token). Model harus re-run tool kalau butuh detail.

Semua mode membuang hal yang sama dari setiap turn yang dikompres:
- Setiap `tool` result message
- Setiap assistant message yang punya `tool_calls` (pesan intermediate "let me check X" + tool call)

Disisakan: `system`, `user`, dan assistant content-only (jawaban final tiap turn).

**Merge defensif**: setelah drop, bisa muncul dua message role sama beruntun. Pass terakhir meng-merge consecutive `user`/`assistant` jadi satu (assistant content dijamin non-empty, fallback `" "` — fix error 400 DeepSeek).

Penting — **scope per user turn**:
- Optimasi dijalankan **sekali di awal `agent.send()`** (setelah user message baru di-push). Pada titik itu, semua `tool` message di history adalah dari turn-turn sebelumnya.
- Snapshot di-lock untuk seluruh tool loop dalam turn itu. Tool result yang muncul di iterasi-iterasi berikutnya (current turn) ditambahkan sebagai `extras` dan selalu utuh.
- Request per iterasi = `optimizedBase + extras`.
- **`recent` mode**: current turn + 1 turn terakhir selalu utuh; turn lebih tua dikompres.

Alasannya: AI butuh tool result dari iterasi sebelumnya untuk merangkai task — kalau di-truncate mid-loop, AI bisa "lupa" hasil yang baru saja dia minta. Sebaliknya, tool result dari turn sebelumnya (task yang sudah selesai) jarang dibutuhkan detailnya — assistant text sudah summarize.

Properti lain:
- **Tidak mengubah `Agent.messages`** — hanya snapshot in-flight untuk request. Session JSON tetap menyimpan history lengkap. Matikan optimasi → history lengkap tersedia kembali.
- Deterministik (Layer 1), tanpa LLM call. Bisa diperluas ke Layer 2 (LLM summary on threshold) di masa depan tanpa mengubah API.
- Agent emit `onContextOptimized(stats)` saat ada collapse. `stats = { collapsedCount, bytesSaved }`. REPL akumulasi ke `ctx.optStats`, tampil di `/usage`.
- Config: `{ enabled: boolean; mode?: OptimizeMode }`. Default `{ enabled: true, mode: "recent" }`.

**Monitoring file**: saat `SIBERFLOW_CONTEXT_OPTIMIZE=true` (default), tiap turn yang sukses juga menulis sibling file `~/.siberflow/sessions/<id>.optimized.json` di samping main session JSON. Bentuknya sama persis dengan `Session`, tapi `messages` di-replace dengan hasil `optimizeContext()` + metadata `_view: "optimized"` dan `_generatedAt`. Berguna untuk:

- Diff: `diff <id>.json <id>.optimized.json` melihat persis apa yang dibuang
- Inspeksi: pastikan tool call/result turn lama terbuang dan current-turn tetap utuh
- Audit: berapa banyak konteks yang sebenarnya dilihat LLM vs yang tersimpan

File `.optimized.json` di-ignore oleh `listSessions()` (cek extension `.optimized.json`) dan di-cascade hapus saat `deleteSession()` / `clearSessions()`. Tidak ada fungsi load untuknya — ini hanya untuk dibaca manual.

Untuk multi-turn percakapan dengan banyak tool history, `prompt_tokens` turun karena tool call & result dari turn-turn lama dibuang saat user mulai turn baru. Storage tetap utuh — matikan optimasi → history lengkap tersedia kembali.

Bisa diperluas ke Layer 2 (LLM summary on threshold) di masa depan tanpa mengubah API ini.

### Task checklist (opt-in)

Aktif via `SIBERFLOW_TASKS=true`. Konsep: checklist sebagai **managed state**, bukan chat history — supaya tahan terhadap context optimization (yang membuang tool history lama).

Komponen:
- [tasks.ts](packages/core/src/agent/tasks.ts) — `Task { content, status }`, `TaskStore` (in-memory holder), `renderTaskList()`
- [tools/task/update.ts](packages/core/src/tools/task/update.ts) — tool `task_update`: model kirim **list lengkap** (full replacement) tiap update. Selalu ter-register (always-on tool). Switch `tasks` (default `true`) kontrol apakah checklist di-injeksi ke system prompt tiap iterasi.
- `ToolContext.taskStore` — Agent menaruh store-nya di sini supaya tool bisa mutasi.

Mekanisme di Agent:
1. Agent punya satu `TaskStore`. `task_update` mengisinya via `ctx.taskStore`.
2. **Re-injeksi tiap iterasi**: `withTasks()` menambahkan checklist ke leading system message setiap LLM call. Jadi model selalu lihat state authoritative — baik setelah update mid-turn maupun lintas-turn (tidak mengandalkan chat history yang bisa di-optimize).
3. Setelah `task_update` dipanggil, emit `onTasksUpdated(tasks)` → CLI render checklist.
4. Persistensi: `Session.tasks` disimpan di JSON; saat `/load`, `agent.loadTasks()` me-restore. **Tiap `onTasksUpdated` di REPL juga langsung `saveSessionSync()`** — checkpoint tahan Ctrl+C / force-kill mid-task. Hanya `tasks` + `updatedAt` yang diupdate; `messages` tetap dari turn terakhir yang sukses (mencegah persist dangling tool_calls).

Kenapa managed state, bukan tool result biasa? Kalau checklist cuma jadi tool result, dia ikut terbuang saat context optimize membersihkan turn lama. Dengan re-injeksi dari store, checklist selalu fresh dan utuh berapapun panjang percakapan.

CLI render (`ui.taskList`): `✔` completed (hijau), `▶` in_progress (kuning bold), `○` pending (dim).

### Session

Storage: `~/.siberflow/sessions/<id>.json`, satu file per sesi.

```ts
interface Session {
  version: number;          // SESSION_FORMAT_VERSION = 1
  id: string;               // = nama file
  name: string | null;
  projectDir: string;
  provider: string;
  model: string;
  createdAt: string;        // ISO
  updatedAt: string;        // ISO
  messages: Message[];
}
```

API di [session/store.ts](packages/core/src/session/store.ts):
- `saveSession(s)`, `saveSessionSync(s)`, `loadSession(id)`, `deleteSession(id)` — `deleteSession` cascade ke `.optimized.json` kalau ada. Sync variant dipakai untuk hot-path persistence (task_update) supaya disk write tuntas sebelum proses bisa exit (Ctrl+C safe)
- `listSessions({ projectDir? })` — sorted descending `updatedAt`; skip file `.optimized.json`
- `findByNameOrId(query, projectDir?)` — match prioritas: name exact → id exact → id prefix
- `clearSessions({ projectDir? })` — batch delete; return count
- `saveOptimizedView(session, optimizedMessages)` — tulis sibling `<id>.optimized.json` (lihat §Context optimization)
- `newSessionId()` — timestamp + random 4-char suffix

CLI memanggil `saveSession()` setelah tiap `agent.send()` sukses. Kalau turn throw, tidak disimpan (history mungkin inconsistent: assistant message ada tapi tool result belum).

`listSessions` di-filter `projectDir` karena message body sering mengandung path absolut yang valid hanya untuk project asal.

## Konfigurasi

Semua via env. CLI loader (`packages/cli/src/env.ts`) walk-up dari cwd cari `.env` (sehingga `npm run dev:cli` dari workspace tetap nemu root `.env`).

| Variabel | Default | Keterangan |
|---|---|---|
| `SIBERFLOW_PROVIDER` | `deepseek` | `deepseek` / `gemini` / `openai` / `openai-responses` / `grok` / `qwen` / `zai` / `claude` |
| `SIBERFLOW_MODEL` | provider default | Override model string |
| `SIBERFLOW_BASE_URL` | provider default | Override endpoint |
| `SIBERFLOW_PROJECT_DIR` | `INIT_CWD` → `cwd()` | Sandbox root. Absolute / relative / `~/...`. Divalidasi exists. |
| `SIBERFLOW_CONTEXT_OPTIMIZE` | `true` | Aktifkan Layer 1 — buang tool call & result dari turn sebelumnya (mode lihat di bawah) |
| `SIBERFLOW_CONTEXT_OPTIMIZE_MODE` | `recent` | `recent` (default; signature breadcrumb, sisakan 1 turn terakhir utuh), `summary` (signature breadcrumb semua turn lama), atau `drop` (buang total tanpa breadcrumb) |
| `SIBERFLOW_TASKS` | `true` | Aktifkan task checklist (`task_update` tool + injeksi state tiap turn). `task_update` selalu ter-register walau ini `false` (default-on), switch ini kontrol injeksi checklist ke system prompt |
| `SIBERFLOW_AUTO_CONTINUE` | `true` | Sambung otomatis respons yang kepotong limit output token (set `false` untuk matikan) |
| `SIBERFLOW_DEBUG` | `false` | Tracing verbose ke stderr (HTTP status, raw finish_reason, usage, error, stream lifecycle) |
| `SIBERFLOW_MAX_ITERATIONS` | `50` | Batas tool-calling iterasi per turn. Naikkan untuk task besar (scaffolding modul, dll) |
| `SIBERFLOW_HIDE_TOOLS` | `false` | Sembunyikan detail tool call di CLI — ganti dengan spinner berlabel nama tool |
| `DEEPSEEK_API_KEY` | — | wajib jika `provider=deepseek` |
| `GEMINI_API_KEY` | — | wajib jika `provider=gemini` |
| `OPENAI_API_KEY` | — | wajib jika `provider=openai` atau `openai-responses` |
| `XAI_API_KEY` | — | wajib jika `provider=grok` |
| `DASHSCOPE_API_KEY` | — | wajib jika `provider=qwen` (Alibaba) |
| `ZAI_API_KEY` | — | wajib jika `provider=zai` (Z.AI / GLM) |
| `ANTHROPIC_API_KEY` | — | wajib jika `provider=claude` (Anthropic) |

Mapping provider → env var nama API key di `config/index.ts` (`apiKeyEnvVar`). Saat tambah provider, tambah case di sana juga.

`INIT_CWD`: npm set ini ke directory tempat `npm run` dipanggil, sebelum chdir ke workspace. Tanpa ini, `npm run dev:cli` dari root menghasilkan `projectDir = packages/cli/` yang salah.

## CLI Rendering

### Startup — session picker

[repl.ts](packages/cli/src/repl.ts) → `chooseSession()`:
1. `listSessions({ projectDir })` ambil maks 10 paling baru
2. Tampilkan list nomor + `[n] buat baru`
3. Loop sampai input valid: nomor (1-10), nama / id (via `findByNameOrId`), atau `n`/`new`/empty
4. Kalau new: prompt nama (Enter = unnamed)

### Loading spinner

[spinner.ts](packages/cli/src/spinner.ts) → `Spinner`. Auto-disabled saat `process.stdout.isTTY` false (piped output).

Lifecycle di [repl.ts](packages/cli/src/repl.ts) `runTurn()`:
- `onAssistantStart` → `spinner.start()` (sembunyikan cursor, draw frame braille setiap 80ms)
- `onContent` / `onToolCallStart` (token/tool call pertama) → `spinner.stop()` (clear line, kembalikan cursor)
- `onAssistantEnd` / error → `spinner.stop()` defensif

Spinner muncul antar iterasi juga (saat agent menunggu balasan setelah tool result).

### Streaming content + markdown

[markdown.ts](packages/cli/src/markdown.ts) → `MarkdownStreamer.renderLine(line)` mengembalikan ANSI-formatted string. Support:
- Code fence ` ``` lang` (multi-line, side border `│`)
- Header `# / ## / ###`
- List `- / * / 1.`
- Block quote `>`
- Inline: `` ` `` / `**` / `~~` / `[text](url)`

Loop streaming di [repl.ts](packages/cli/src/repl.ts) `runTurn()`:
1. Tiap char content di-write raw ke stdout (visible char-by-char)
2. `currentLine` akumulasi char
3. Saat `\n` masuk delta: panggil `flushCurrentLine(true)`
4. `flushCurrentLine`:
   - Hitung `rowsUsed = ceil((currentLine + prefix) / termWidth)`
   - Move cursor up `rowsUsed - 1` baris
   - `\r\x1b[0J` clear dari cursor ke end of display
   - Re-print prefix (kalau first line) + `md.renderLine(currentLine)` + `\n`

Pendekatan ini memberi streaming responsif + final formatting. Multi-row clear penting untuk baris yang wrap di terminal.

### Streaming tool args

[tool-renderer.ts](packages/cli/src/tool-renderer.ts) → `ToolCallRenderer`:
- `onToolCallStart` → instansiasi renderer + print header `↳ tool <name>`
- `onToolCallArgs(delta)` → write raw ke stdout (JSON apa adanya, no parsing)
- `onToolResult(result)` → print result (truncate 400 chars preview)

Tidak ada parser JSON di sini sengaja — supaya forwarding instant tanpa scan-buffer.

**Hide-tools mode** (`SIBERFLOW_HIDE_TOOLS=true`): `ToolCallRenderer` tidak dipakai. Sebagai gantinya `onToolCallStart` mengeset label spinner ke nama tool (`read_file…`) dan membiarkannya berputar selama eksekusi; args & result tidak ditampilkan. `onToolResult` mengembalikan label ke `thinking…`. Output jadi bersih — hanya teks assistant + spinner aktivitas.

### Slash commands

Di-handle di `handleSlashCommand()`:

| Command | Aksi |
|---|---|
| `/help` | print help |
| `/tools` | list registered tools |
| `/list` | list sesi project ini, mark active |
| `/new [name]` | reset agent, set ctx.current ke sesi baru |
| `/load <name\|id>` | load session via `findByNameOrId`, `agent.loadHistory()` |
| `/name <name>` | rename + save current session |
| `/save` | force save current |
| `/delete <name\|id>` | hapus 1 session (kalau current → reset) |
| `/clear-all` | hapus SEMUA session project ini (konfirmasi `yes`) |
| `/exit`, `/quit` | keluar |

## VSCode Extension

Package `packages/vscode-ext` membungkus `@siberflow/core` jadi sidebar chat panel. Reuse semua logic agent, tools, session, optimize, tasks — interface beda saja.

### Arsitektur

- **WebviewViewProvider** terdaftar di activity bar via `viewsContainers` + `views` di [package.json](packages/vscode-ext/package.json). Icon SVG di `resources/icon.svg`.
- **Extension host** ([chat-panel.ts](packages/vscode-ext/src/chat-panel.ts)) memegang state: `Agent`, `Session`, `Provider`, `Registry`, `Settings`. Lazy-init: agent dibangun setelah API key tersedia, bukan saat constructor.
- **Webview side** ([webview/main.ts](packages/vscode-ext/webview/main.ts)) cuma UI + DOM. Tidak punya akses Node — terima event dari extension via `postMessage`.

### Bundling

[esbuild.config.mjs](packages/vscode-ext/esbuild.config.mjs) menghasilkan dua bundle:
- `dist/extension.cjs` — extension host, platform=node, format=cjs, external `vscode`
- `dist/webview.js` — webview script, platform=browser, format=iife (bundle `marked` di dalamnya)

### Konfigurasi (TIDAK pakai `.env`)

- **API key** → `vscode.SecretStorage` (encrypted, OS-keychain backed), key per provider: `siberflow.apiKey.<providerName>`
- **Setting lainnya** → `vscode.workspace.getConfiguration("siberflow")` dengan `ConfigurationTarget.Global`:
  `provider`, `model`, `tasks`, `contextOptimize`, `autoContinue`, `hideTools`, `maxIterations`, `debug`
- **Defaults berbeda dari CLI**: di VSCode, `tasks`, `contextOptimize`, `autoContinue`, dan `hideTools` semuanya **default `true`** (di CLI sebagian default `false`) — UI desktop punya bandwidth lebih untuk fitur agentic, jadi diaktifkan out-of-the-box
- **`projectDir`** → `workspaceFolders[0].uri.fsPath` (sandbox tools otomatis ke folder yang dibuka)

Settings panel di webview menulis ke kedua tempat. Tidak ada fallback ke env var di extension.

### Protokol Webview ↔ Extension

[protocol.ts](packages/vscode-ext/src/protocol.ts) mendefinisikan dua union type tipped:
- `ExtToView`: `ready`, `assistant_start`, `assistant_content`, `iteration_end`, `assistant_end`, `tool_call_start`, `tool_call_args`, `tool_result`, `tasks`, `context_optimized`, `max_iterations`, `error`, `info`, `session_changed`, `usage`, `settings`, `history`, `excel_files_picked`, `excel_pick_error`
- `ViewToExt`: `init`, `send`, `stop`, `regenerate`, `edit_last`, `command`, `save_settings`, `pick_excel_files`

Lifecycle khas:
1. Webview load → kirim `init`
2. Extension cek SecretStorage. Kosong → kirim `settings` dengan `mustConfigure: true`. Webview tampilkan modal yang tidak bisa di-Cancel.
3. Save settings → extension persist + rebuild Agent + jalankan session picker via `vscode.window.showQuickPick`
4. Kirim `ready` (banner + session + flags), lalu `history` (recap user+assistant text untuk sesi yang di-load), lalu `tasks` (kalau ada)
5. User kirim message → `send` → extension run `agent.send()` dengan event handler yang forward jadi `assistant_*`, `tool_*`, `tasks`, dll

### UI components (webview)

- **Topbar compact**: tombol session label (klik → popover info versi/provider/session) + tombol `⋯` (popover command menu: Settings, New, Load, Usage, Clear all)
- **Messages area**: scrollable; tiap `msg` = user/assistant card; tool block & task card inline di antara messages
- **Task card** inline di `#messages` — bukan panel fixed, scroll bareng chat. Update in-place tiap `task_update`.
- **Composer**: textarea rounded + tombol Send bundar 28×28 dengan SVG arrow icon + tombol paperclip upload Excel (chip attachment, `pick_excel_files` message ke host)
- **Pending indicator** (`◴ thinking…`) muncul saat submit, hilang saat event pertama
- **Settings modal**: backdrop overlay; form provider/apiKey/model + toggle checkboxes
- **Markdown**: `marked` lib di-bundle untuk render assistant message (text streaming dulu, parse markdown saat `assistant_end`)

### Cross-compat dengan CLI

Sesi tersimpan di `~/.siberflow/sessions/<id>.json` (lokasi sama). Sesi yang dibuat via CLI bisa di-load di VSCode dan sebaliknya — format dan API store identik. Tidak ada migrasi atau lock file.

### Test/run (dev mode)

```bash
cd packages/vscode-ext
code .       # buka folder di VSCode
# tekan F5 (Run Extension) → Extension Development Host
```

Build manual: `npm run build:vscode` di root. Watch mode: `npm run watch:vscode`.

### Build VSIX (untuk distribusi tanpa marketplace)

```bash
npm run package:vscode      # dari root
# atau:
cd packages/vscode-ext && npm run package
```

```bash
cd packages/vscode-ext
npx vsce publish patch --no-dependencies
```

`patch` bump versi (0.1.0 → 0.1.1) lalu publish. `--no-dependencies` skip dependency detection karena esbuild sudah inline semua runtime deps. `vsce` (devDep ekstensi, no global install) butuh **Personal Access Token** (PAT) dari Azure DevOps / VS Code Marketplace — di-set via env var `VSCE_PAT` atau prompt interaktif saat publish. Lihat https://code.visualstudio.com/api/working-with-extensions/publishing-extension untuk cara bikin PAT.

Yang ter-bundle di VSIX:
```
extension/
├─ package.json
├─ readme.md             # tampil di halaman info ekstensi
├─ dist/
│  ├─ extension.cjs      # ext host (inline @siberflow/core + marked)
│  └─ webview.js         # webview UI
└─ resources/icon.svg
```

Self-contained — `--no-dependencies` skip `npm install` step karena esbuild sudah inline semua runtime deps. `.vscodeignore` mengeksklusi `src/`, `webview/`, `node_modules/`, `.env*`, `*.vsix`, `*.map`, dll. Hanya `dist/` dan `resources/` yang ikut.

Install di VSCode lain:
- GUI: Cmd+Shift+P → **Extensions: Install from VSIX…**
- CLI: `code --install-extension siberflow-chat-<version>.vsix`

Update versi: edit `version` di `packages/vscode-ext/package.json` (SemVer), `npm run package:vscode`. VSCode otomatis prompt update kalau VSIX baru di-install ulang dengan versi lebih tinggi.

### Publish ke marketplace (optional)

Kalau nanti mau publish:
1. Bikin publisher di https://marketplace.visualstudio.com/manage
2. PAT dari Azure DevOps dengan scope **Marketplace > Manage**
3. `vsce login <publisher-id>` → paste PAT
4. `vsce publish` (atau `vsce publish patch`/`minor` untuk auto-bump)

Perlu juga: marketplace icon PNG 128×128 (`resources/icon.png` + field `icon` di package.json) — saat ini hanya SVG untuk activity bar, marketplace tetap minta PNG terpisah.

## Desktop App (Electron)

Package `packages/desktop` — aplikasi desktop standalone (mirip Claude Desktop). UI React + Vite, terpisah total dari CLI/VSCode karena kebutuhan desktop berbeda (window management, folder picker per-session, multi-session sidebar, branding installer). Mengkonsumsi `@siberflow/core` langsung.

### Arsitektur

Dua proses terpisah dengan typed IPC bridge:

```
┌─────────────────────────────────────┐
│  Main Process (Node.js, ESM)        │
│  ├─ BrowserWindow + app lifecycle   │
│  ├─ AgentHost (mirrors chat-panel)  │ ← @siberflow/core
│  ├─ ipcMain handlers                │
│  ├─ safeStorage (API keys)          │
│  └─ dialog (folder picker)          │
│         │ contextBridge             │
│         ▼                           │
│  Renderer (React, sandboxed)        │
│  ├─ Sidebar (multi-session)         │
│  ├─ ChatView (messages + tools)     │
│  ├─ Composer + TaskPanel            │
│  └─ SettingsModal                   │
└─────────────────────────────────────┘
```

### Main Process

- **[main/index.ts](packages/desktop/src/main/index.ts)** — `app.whenReady`, `BrowserWindow` (1000×720), preload path, branding (`app.setName("Siberflow")`, window icon)
- **[main/agent-host.ts](packages/desktop/src/main/agent-host.ts)** — `AgentHost` class: port logic dari VSCode `chat-panel.ts`. Mengelola lifecycle Agent, provider, registry, sessions, turn runner dengan `AbortController`. Auto-name session dari first user message (6 kata pertama)
- **[main/ipc.ts](packages/desktop/src/main/ipc.ts)** — semua `ipcMain.handle` registration, forwarding streaming events ke renderer via `webContents.send`
- **[main/secrets.ts](packages/desktop/src/main/secrets.ts)** — wrapper `safeStorage`: `getApiKey(provider)`, `setApiKey`, `deleteApiKey`. Encrypt ke `userData/siberflow-keys.json`
- **[main/settings.ts](packages/desktop/src/main/settings.ts)** — JSON settings store di `userData/siberflow-settings.json`

### Preload

[preload/index.ts](packages/desktop/src/preload/index.ts) — `contextBridge.exposeInMainWorld("siberflow", api)`. Renderer hanya bisa panggil method ter-typed, tidak ada akses Node langsung (`contextIsolation: true`, `nodeIntegration: false`).

### Shared protocol

[shared/protocol.ts](packages/desktop/src/shared/protocol.ts) — contract ter-typed antara main dan renderer:
- `MainEvent` — 18 union types (streaming events: `assistant-start`, `assistant-content`, `tool-call-start`, `tasks`, `error`, dll) dikirim main → renderer
- `RendererCalls` — method interface yang renderer panggil (`send`, `stop`, `newSession`, `loadSession`, `pickFolder`, `setWorkdir`, `pickExcelFiles`, `saveSettings`, dll)
- `SettingsValues`, `SessionSummary`, `UsageInfo` — tipe data bersama

### Renderer (React)

State management via reducer (`hooks/useChat.ts`) yang subscribe ke streaming events:

```ts
type ContentBlock =
  | { kind: "text"; id: number; text: string }
  | { kind: "tool"; id: number; tool: ToolCall };
type AssistantTurn = { role: "assistant"; blocks: ContentBlock[] };
```

Setiap assistant turn = list berurutan text + tool blocks. IDs monoton (`++blockSeq`) untuk hindari collision antar iteration. User message ditampilkan optimistic via action `user-send` sebelum backend turn selesai.

Komponen:
- **App.tsx** — root layout: resizable sidebar + chat area (centered max-width 760px) + floating task panel + modals
- **Sidebar.tsx** — session list grouped per folder, new/delete, rename inline (double-click)
- **Message.tsx** — user/assistant bubbles dengan `react-markdown` + collapsible tool blocks (skip `task_update`)
- **Composer.tsx** — auto-resize textarea, Enter to send, Shift+Enter newline, send/stop button, tombol paperclip untuk upload Excel (chip attachment + `buildPromptWithAttachments`)
- **TaskPanel.tsx** — floating kanan-atas, collapsible, progress bar
- **SettingsModal.tsx** — provider select, API key, agent config (grouped sections)

### Konfigurasi (TIDAK pakai `.env`)

Sama seperti VSCode extension — settings tersimpan lokal, bukan env:
- **API key** → Electron `safeStorage` (OS keychain encrypted)
- **Setting lainnya** → JSON di `userData/siberflow-settings.json`: `provider`, `model`, `tasks`, `contextOptimize`, `autoContinue`, `hideTools`, `maxIterations`, `debug`
- **`projectDir`** → pilih per-session via native folder picker dialog (`dialog.showOpenDialog`)

### Bundling

[electron.vite.config.ts](packages/desktop/electron.vite.config.ts) — tiga output via `electron-vite`:
- `out/main/index.js` — main process (esbuild, external native modules `ssh2`/`sqlite3`/`pg`/`mysql2`/`puppeteer-core`/`fsevents`)
- `out/preload/index.mjs` — preload bridge
- `out/renderer/` — Vite + React (HMR saat dev)

### Packaging

[electron-builder.yml](packages/desktop/electron-builder.yml) — installer config:
- macOS: `.dmg` (arm64/x64)
- Windows: NSIS `.exe`
- Linux: `.AppImage`

```bash
npm run package:mac    # → packages/desktop/dist/Siberflow-<version>-arm64.dmg (~110MB)
```

Native modules (`ssh2`, `sqlite3`, `cpu-features`) otomatis di-rebuild untuk Electron ABI via `postinstall: electron-builder install-app-deps`. Penting: version `electron` di package.json harus **fixed** (bukan `^`), karena electron-builder butuh binary exact match.

### Branding

- `app.setName("Siberflow")` di main process → OS menampilkan nama benar di dock/menubar
- `productName: "Siberflow"` di package.json
- App icons generated dari `resources/icon.svg` (background gradient biru + logo S putih):
  - `icon.icns` (macOS, 16–1024px)
  - `icon.ico` (Windows, 16–256px)
  - `icon.png` (Linux, 512×512)

### Cross-compat dengan CLI & VSCode

Session files di lokasi yang sama (`~/.siberflow/sessions/`), format identik. Session dibuat via desktop bisa di-load di CLI/VSCode dan sebaliknya.

## Build & Dev

| Script | Aksi |
|---|---|
| `npm install` | resolve workspaces |
| `npm run build` | core → cli → vscode-ext (urutan eksplisit, bukan alphabetical) |
| `npm run build:core` | build hanya core (prasyarat desktop/cli) |
| `npm run build:desktop` | core → desktop (electron-vite build) |
| `npm run dev:cli` | tsx (no rebuild) — paling cepat untuk iterasi |
| `npm run cli` | run dari `dist/` (perlu build dulu) |
| `npm run dev:desktop` | electron-vite dev (HMR renderer, auto-reload main) |
| `npm run package:desktop` | build + electron-builder (auto-detect platform) |
| `npm run package:mac` | build + electron-builder --mac (.dmg) |
| `npm run rebuild:desktop` | rebuild native modules untuk Electron ABI |
| `npm run clean` | hapus semua `dist/` dan `out/` |

### TypeScript project references

`packages/cli/tsconfig.json` reference `../core`. `packages/core/tsconfig.json` punya `composite: true`. Build cli butuh `.d.ts` core sudah ada — itu sebabnya root script chain dengan `&&`.

Kalau ada error stale incremental: `find packages -name "*.tsbuildinfo" -delete && npm run clean && npm run build`.

Mode dev (`tsx`) tidak perlu build core dulu.

## Cara Menambah

### Provider baru

**Kalau provider pakai OpenAI chat completions wire format** (DeepSeek, OpenRouter, Groq, vLLM, dll):

```ts
import { OpenAICompatibleProvider } from "./openai-compatible.js";
export class FooProvider extends OpenAICompatibleProvider {
  constructor(config) {
    super(config, { name: "foo", defaultModel: "foo-1", defaultBaseUrl: "https://..." });
  }
}
```

**Kalau format berbeda** (Anthropic Messages, Gemini native, OpenAI Responses, dll): implement `Provider` interface langsung. Lihat [openai-responses.ts](packages/core/src/providers/openai-responses.ts) sebagai contoh — wajib map format wire ke `StreamEvent` internal. Reuse `parseSSE` dari [sse.ts](packages/core/src/providers/sse.ts).

Setelah file provider dibuat:

1. Tambah case di `providers/registry.ts` (ProviderName + switch).
2. Tambah case di `config/index.ts` (`apiKeyEnvVar`).
3. Tambah env var di `.env.example`.

### Tool baru

1. Buat `packages/core/src/tools/<category>/<name>.ts`:
   ```ts
   import type { Tool } from "../base.js";
   import { resolveWithin } from "./path-utils.js";  // kalau menyentuh fs

   export const fooTool: Tool = {
     name: "foo",
     description: "untuk LLM",
     parameters: { type: "object", properties: {...}, required: [...], additionalProperties: false },
     async execute(args, ctx) {
       const path = await resolveWithin(ctx.projectDir, args.path);
       // ...
       return "result string";
     },
   };
   ```
2. Tambah ke array di `<category>/index.ts` (atau buat kategori baru di `tools/index.ts`).

**Wajib** sandbox semua path user-provided lewat `resolveWithin` (atau `resolveExcelPath` kalau tool butuh akses upload dir selain project). Kalau tool run kode user-supplied (exceljs/Puppeteer), pakai vm sandbox (`tools/excel/script.ts` pattern) atau child_process isolation (`tools/browser/browser.ts` pattern) — jangan pernah `eval` langsung di host process.

Contoh kategori yang sudah ada di repo:
- `tools/file/*` untuk operasi filesystem
- `tools/cli/*` untuk shell command
- `tools/db/*` untuk akses database
- `tools/excel/*` untuk spreadsheet `.xlsx` (read pakai `resolveExcelPath` agar bisa baca upload dir; write tetap `resolveWithin` project; script mode pakai vm sandbox untuk full exceljs API)
- `tools/ssh/*` untuk remote shell & SFTP
- `tools/browser/*` untuk scraping/interaksi web via headless Chrome/Edge Puppeteer (child_process worker, pakai browser yang sudah terinstall)
- `tools/task/*` untuk task checklist

Kalau tool baru butuh opt-in (default OFF), tambah nama tool ke `TOGGLE_TOOLS` array di `SettingsModal.tsx` (Desktop) + `webview/main.ts` (VSCode) + list di `.env.example`. Filter otomatis lewat `enabledTools` di `createDefaultRegistry`.

### Interface baru (web/desktop)

Buat workspace baru di `packages/<name>/`, depend ke `@siberflow/core`. Subscribe `AgentEvents`, kelola session lifecycle pakai `saveSession/loadSession`. Tidak perlu modifikasi core. Lihat `packages/desktop` (Electron + React) atau `packages/vscode-ext` (webview) sebagai contoh pola integrasi.

## Catatan Keamanan Singkat

- File tools sandboxed ke `projectDir` (hard).
- `read_excel` punya whitelist tambahan: boleh baca path absolut di dalam `uploadDir` (tmp upload dir, per-session, mode 0700). Tool file lain tidak terima field `uploadDir` → tetap terkunci di project.
- Upload Excel disimpan di `os.tmpdir()/siberflow-uploads/<sessionId>/` (bukan project) — workspace bersih, tidak ikut git. Cleanup otomatis saat `deleteSession`. Folder owner-only (mode 0700) untuk mitigasi `/tmp` world-readable di Linux multi-user.
- `write_excel` output tetap sandbox `projectDir` — file Excel yang AI hasilkan harus di project, bukan tmp.
- `write_excel_script` run kode AI-supplied di `node:vm` sandbox terkunci: `require`/`process`/`fs`/`eval`/`Function` di-block, timeout 5 detik. Compile + invoke dalam satu `runInContext` supaya timeout cover infinite loop.
- `run_browser` run kode AI-supplied (Puppeteer) di **child process worker terisolasi** (bukan vm — Puppeteer async gak kompatibel). Worker gak punya akses host memory/session/AgentHost; env minimal (gak leak secrets); timeout kill process tree. Pakai Chrome/Edge yang sudah terinstall di sistem (channel `'chrome'` → fallback `'msedge'`), tidak ada download Chromium. `puppeteer-core` di-resolve via env var `SIBERFLOW_PUPPETEER_CORE_PATH` (host set) atau heuristik di `resolvePuppeteerCorePath()`.
- Per-tool toggle (`enabledTools`): tool berbahaya (`exec`, `db_query`, `ssh_exec`, `run_browser`, dll) default OFF — opt-in via settings/env supaya blast-radius security kecil walau AI coba pakai. Pengecualian: `task_update` dan `ask_user` selalu on (core UX).
- `exec` tool cwd=projectDir tapi shell bisa akses path lain (soft). OK untuk single-user dev; untuk multi-user / web public perlu permission layer.
- API key:
  - CLI: plain text di env / `.env` (gitignored)
  - VSCode: `vscode.SecretStorage` (OS keychain, encrypted)
  - Desktop: Electron `safeStorage` (OS keychain, encrypted) di `userData/siberflow-keys.json`
- Session JSON di `~/.siberflow/sessions/` un-encrypted, mode 644. Berisi tool call args (termasuk db password / ssh key) verbatim — aware untuk deployment multi-user.
- `task_update` tool silent di semua interface (tetap dieksekusi, tidak dirender di transcript).
