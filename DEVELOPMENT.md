# Siberflow — Developer Reference

Referensi teknis untuk developer yang akan memperluas atau memodifikasi siberflow.

Stack: TypeScript (ESM, NodeNext), Node 20+, npm workspaces. Zero runtime dependency di `@siberflow/core`.

## Repository

```
siberflow/
├── package.json              # workspaces root; build script chains core → cli
├── tsconfig.base.json        # shared strict TS config + types:[node]
├── .env.example
└── packages/
    ├── core/                 # @siberflow/core (composite TS project)
    │   └── src/
    │       ├── agent/
    │       │   ├── types.ts       # Message, ToolCall, StreamEvent, FinishReason
    │       │   ├── agent.ts       # class Agent — streaming loop
    │       │   ├── optimize.ts    # optimizeContext() — Layer 1 context compaction
    │       │   └── tasks.ts       # Task, TaskStore, renderTaskList
    │       ├── providers/
    │       │   ├── base.ts        # interface Provider (chatStream only)
    │       │   ├── sse.ts         # parseSSE() — shared SSE parser
    │       │   ├── openai-compatible.ts  # base class untuk /chat/completions style
    │       │   ├── deepseek.ts    # extends OpenAICompatibleProvider
    │       │   ├── gemini.ts      # extends OpenAICompatibleProvider
    │       │   ├── openai.ts      # extends OpenAICompatibleProvider (/v1/chat/completions)
    │       │   ├── openai-responses.ts   # standalone — OpenAI /v1/responses API
    │       │   └── registry.ts    # createProvider(name, config)
    │       ├── tools/
    │       │   ├── base.ts        # interface Tool, ToolContext { projectDir }
    │       │   ├── registry.ts    # class ToolRegistry
    │       │   ├── file/
    │       │   │   ├── path-utils.ts # resolveWithin() — sandbox resolver
    │       │   │   ├── read.ts | write.ts | edit.ts | copy.ts | list.ts
    │       │   │   └── index.ts   # fileTools[]
    │       │   ├── cli/
    │       │   │   ├── exec.ts    # shell exec, cwd=projectDir
    │       │   │   └── index.ts
    │       │   ├── task/
    │       │   │   ├── update.ts  # task_update tool (opt-in via SIBERFLOW_TASKS)
    │       │   │   └── index.ts
    │       │   └── index.ts       # createDefaultRegistry({ tasks? })
    │       ├── session/
    │       │   ├── types.ts       # Session, SessionSummary, SESSION_FORMAT_VERSION
    │       │   └── store.ts       # save/load/list/delete/clear/findByNameOrId
    │       ├── config/index.ts    # loadConfigFromEnv()
    │       └── index.ts           # re-exports
    └── cli/                  # @siberflow/cli (references core)
        ├── bin/siberflow.js  # shim → dist/index.js
        └── src/
            ├── index.ts           # entry: load env, build deps, runRepl()
            ├── env.ts             # .env loader (walk-up, no deps)
            ├── repl.ts            # session picker + main loop + slash commands
            ├── markdown.ts        # MarkdownStreamer (renderLine for live reformat)
            ├── tool-renderer.ts   # ToolCallRenderer (raw arg streaming)
            ├── spinner.ts         # Spinner (loading animation, TTY-only)
            └── ui.ts              # ANSI colors + splashBanner + helpers
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
  projectDir: string;  // sandbox root
}
```

Tool return string yang akan dikirim balik ke LLM sebagai `tool` message content. Throw `Error` untuk kegagalan — `ToolRegistry.execute()` yang menangkap & convert ke "Error: ..." string.

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

[optimize.ts](packages/core/src/agent/optimize.ts) → `optimizeContext(messages, config)` membuang seluruh jejak tool dari turn sebelumnya, menyisakan hanya **teks final assistant per turn**. Returns array baru; input tidak di-mutasi.

Dibuang:
- Setiap `tool` result message
- Setiap assistant message yang punya `tool_calls` (pesan intermediate "let me check X" + tool call)

Disisakan: `system`, `user`, dan assistant content-only (jawaban final tiap turn).

**Tanpa breadcrumb.** Versi awal sempat menaruh note `[called read_file(...) — omitted]`, tapi ternyata bikin model bingung dan **mengulang** tool call. Jadi jejak tool dihapus total — teks final assistant ("Selesai, sudah saya tulis ulang ke out.ts") yang membawa konteks ke depan.

Contoh nyata: 12 message → 6 message, history jadi alternasi bersih `system → user → assistant → user → ...`.

**Merge defensif**: kalau suatu turn tidak menghasilkan teks final (mis. maxIterations habis), bisa muncul dua message role sama beruntun. Pass terakhir meng-merge consecutive `user`/`assistant` jadi satu, supaya request tetap valid untuk API yang strict.

Penting — **scope per user turn**:
- Optimasi dijalankan **sekali di awal `agent.send()`** (setelah user message baru di-push). Pada titik itu, semua `tool` message di history adalah dari turn-turn sebelumnya.
- Snapshot di-lock untuk seluruh tool loop dalam turn itu. Tool result yang muncul di iterasi-iterasi berikutnya (current turn) ditambahkan sebagai `extras` dan selalu utuh.
- Request per iterasi = `optimizedBase + extras`.

Alasannya: AI butuh tool result dari iterasi sebelumnya untuk merangkai task — kalau di-truncate mid-loop, AI bisa "lupa" hasil yang baru saja dia minta. Sebaliknya, tool result dari turn sebelumnya (task yang sudah selesai) jarang dibutuhkan detailnya — assistant text sudah summarize.

Properti lain:
- **Tidak mengubah `Agent.messages`** — hanya snapshot untuk request. Session JSON tetap menyimpan history lengkap.
- Deterministik, tanpa LLM call.
- Agent emit `onContextOptimized(stats)` saat ada collapse. `stats = { collapsedCount, bytesSaved }`. REPL akumulasi ke `ctx.optStats`, tampil di `/usage`.
- Config-nya cuma `{ enabled: boolean }` — tidak ada knob lain.

**Monitoring file**: saat `SIBERFLOW_CONTEXT_OPTIMIZE=true`, tiap turn yang sukses juga menulis sibling file `~/.siberflow/sessions/<id>.optimized.json` di samping main session JSON. Bentuknya sama persis dengan `Session`, tapi `messages` di-replace dengan hasil `optimizeContext()` + metadata `_view: "optimized"` dan `_generatedAt`. Berguna untuk:

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
- [tools/task/update.ts](packages/core/src/tools/task/update.ts) — tool `task_update`: model kirim **list lengkap** (full replacement) tiap update. Hanya ter-register kalau `createDefaultRegistry({ tasks: true })`.
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
| `SIBERFLOW_PROVIDER` | `deepseek` | `deepseek` / `gemini` / `openai` / `openai-responses` |
| `SIBERFLOW_MODEL` | provider default | Override model string |
| `SIBERFLOW_BASE_URL` | provider default | Override endpoint |
| `SIBERFLOW_PROJECT_DIR` | `INIT_CWD` → `cwd()` | Sandbox root. Absolute / relative / `~/...`. Divalidasi exists. |
| `SIBERFLOW_CONTEXT_OPTIMIZE` | `false` | Aktifkan Layer 1 — buang tool call & result dari turn sebelumnya, sisakan teks final assistant |
| `SIBERFLOW_TASKS` | `false` | Aktifkan task checklist (`task_update` tool + injeksi state tiap turn) |
| `SIBERFLOW_AUTO_CONTINUE` | `true` | Sambung otomatis respons yang kepotong limit output token (set `false` untuk matikan) |
| `SIBERFLOW_DEBUG` | `false` | Tracing verbose ke stderr (HTTP status, raw finish_reason, usage, error, stream lifecycle) |
| `SIBERFLOW_MAX_ITERATIONS` | `50` | Batas tool-calling iterasi per turn. Naikkan untuk task besar (scaffolding modul, dll) |
| `SIBERFLOW_HIDE_TOOLS` | `false` | Sembunyikan detail tool call di CLI — ganti dengan spinner berlabel nama tool |
| `DEEPSEEK_API_KEY` | — | wajib jika `provider=deepseek` |
| `GEMINI_API_KEY` | — | wajib jika `provider=gemini` |
| `OPENAI_API_KEY` | — | wajib jika `provider=openai` atau `openai-responses` |

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

## Build & Dev

| Script | Aksi |
|---|---|
| `npm install` | resolve workspaces |
| `npm run build` | core → cli (urutan eksplisit, bukan alphabetical) |
| `npm run dev:cli` | tsx (no rebuild) — paling cepat untuk iterasi |
| `npm run cli` | run dari `dist/` (perlu build dulu) |
| `npm run clean` | hapus semua `dist/` |

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

**Wajib** sandbox semua path user-provided lewat `resolveWithin`.

### Interface baru (web/vscode)

Buat workspace baru di `packages/<name>/`, depend ke `@siberflow/core`. Subscribe `AgentEvents`, kelola session lifecycle pakai `saveSession/loadSession`. Tidak perlu modifikasi core.

## Catatan Keamanan Singkat

- File tools sandboxed ke `projectDir` (hard).
- `exec` tool cwd=projectDir tapi shell bisa akses path lain (soft). OK untuk single-user dev; untuk multi-user / web public perlu permission layer.
- API key plain text di env. Untuk produksi multi-user pakai secret manager.
- Session JSON di `~/.siberflow/sessions/` un-encrypted, mode 644.
