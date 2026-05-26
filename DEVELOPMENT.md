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
    │       │   └── agent.ts       # class Agent — streaming loop
    │       ├── providers/
    │       │   ├── base.ts        # interface Provider (chatStream only)
    │       │   ├── openai-compatible.ts  # base class: SSE + tool delta accumulator
    │       │   ├── deepseek.ts    # extends OpenAICompatibleProvider
    │       │   ├── gemini.ts      # extends OpenAICompatibleProvider
    │       │   ├── openai.ts      # extends OpenAICompatibleProvider
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
    │       │   └── index.ts       # createDefaultRegistry()
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

Base class `OpenAICompatibleProvider` di [openai-compatible.ts](packages/core/src/providers/openai-compatible.ts) menangani:

1. Konversi `Message[]` → format OpenAI chat completions
2. POST dengan `stream: true` + optional `stream_options.include_usage`
3. SSE parser: `\n\n` delimiter, baca `data: {json}` per event
4. Akumulasi tool_call deltas di `Map<index, ToolCall>`
5. Emit `StreamEvent` ke iterator

DeepSeek / Gemini / OpenAI subclass-nya cuma override 3 string: `name`, `defaultModel`, `defaultBaseUrl`.

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

`maxIterations` default 16, mencegah infinite tool loop.

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
- `saveSession(s)`, `loadSession(id)`, `deleteSession(id)`
- `listSessions({ projectDir? })` — sorted descending `updatedAt`
- `findByNameOrId(query, projectDir?)` — match prioritas: name exact → id exact → id prefix
- `clearSessions({ projectDir? })` — batch delete; return count
- `newSessionId()` — timestamp + random 4-char suffix

CLI memanggil `saveSession()` setelah tiap `agent.send()` sukses. Kalau turn throw, tidak disimpan (history mungkin inconsistent: assistant message ada tapi tool result belum).

`listSessions` di-filter `projectDir` karena message body sering mengandung path absolut yang valid hanya untuk project asal.

## Konfigurasi

Semua via env. CLI loader (`packages/cli/src/env.ts`) walk-up dari cwd cari `.env` (sehingga `npm run dev:cli` dari workspace tetap nemu root `.env`).

| Variabel | Default | Keterangan |
|---|---|---|
| `SIBERFLOW_PROVIDER` | `deepseek` | `deepseek` / `gemini` / `openai` |
| `SIBERFLOW_MODEL` | provider default | Override model string |
| `SIBERFLOW_BASE_URL` | provider default | Override endpoint |
| `SIBERFLOW_PROJECT_DIR` | `INIT_CWD` → `cwd()` | Sandbox root. Absolute / relative / `~/...`. Divalidasi exists. |
| `DEEPSEEK_API_KEY` | — | wajib jika `provider=deepseek` |
| `GEMINI_API_KEY` | — | wajib jika `provider=gemini` |
| `OPENAI_API_KEY` | — | wajib jika `provider=openai` |

Mapping provider → env var nama API key di `config/index.ts` (`apiKeyEnvVar`). Saat tambah provider, tambah case di sana juga.

`INIT_CWD`: npm set ini ke directory tempat `npm run` dipanggil, sebelum chdir ke workspace. Tanpa ini, `npm run dev:cli` dari root menghasilkan `projectDir = packages/cli/` yang salah.

## CLI Rendering

### Startup — session picker

[repl.ts](packages/cli/src/repl.ts) → `chooseSession()`:
1. `listSessions({ projectDir })` ambil maks 10 paling baru
2. Tampilkan list nomor + `[n] buat baru`
3. Loop sampai input valid: nomor (1-10), nama / id (via `findByNameOrId`), atau `n`/`new`/empty
4. Kalau new: prompt nama (Enter = unnamed)

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

1. Buat `packages/core/src/providers/<name>.ts`:
   ```ts
   import { OpenAICompatibleProvider } from "./openai-compatible.js";
   export class FooProvider extends OpenAICompatibleProvider {
     constructor(config) {
       super(config, { name: "foo", defaultModel: "foo-1", defaultBaseUrl: "https://..." });
     }
   }
   ```
2. Tambah case di `providers/registry.ts` (ProviderName + switch).
3. Tambah case di `config/index.ts` (`apiKeyEnvVar`).
4. Tambah env var di `.env.example`.

Provider dengan format wire berbeda (Anthropic Messages, dll) implement `Provider` interface langsung, jangan extend OpenAICompatibleProvider.

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
