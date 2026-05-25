# Siberflow — Developer Documentation

Dokumen ini ditujukan untuk developer yang akan **mengembangkan, memperluas, atau berkontribusi** ke siberflow. Kalau hanya ingin menjalankan CLI-nya, baca [README.md](README.md).

---

## 1. Apa itu Siberflow

Siberflow adalah platform AI yang dirancang sebagai **lapisan abstraksi** di atas berbagai LLM provider, dengan dukungan **tool calling streaming** native, **path sandbox** untuk operasi file, **persistensi multi-session**, dan beberapa **interface** (CLI sekarang; web & VSCode extension menyusul).

Empat prinsip desain utama:

1. **Provider-agnostic** — agent loop tidak tahu apa-apa tentang DeepSeek, OpenAI, atau Anthropic. Semua provider memenuhi interface `Provider` yang sama (streaming).
2. **Tool-agnostic** — agent loop tidak punya tool yang hardcoded. Semua tool didaftarkan ke `ToolRegistry` dan diekspos ke model sebagai JSON schema.
3. **Interface-agnostic** — logika percakapan (`Agent` + sessions) hidup di `@siberflow/core`. Interface (CLI / Web / VSCode) hanya menjadi shell tipis di sekelilingnya.
4. **Streaming end-to-end** — token model dan delta JSON tool args di-forward dari HTTP wire sampai stdout/UI tanpa buffering yang tidak perlu.

Konsekuensinya: menambah provider, tool, atau interface baru **tidak mengubah** lapisan lainnya.

---

## 2. Arsitektur Tingkat Tinggi

```
                  ┌─────────────────────────────────────────────┐
                  │              Interfaces                     │
                  │   CLI (sekarang) · Web · VSCode (rencana)   │
                  └────────────────────┬────────────────────────┘
                                       │ memakai
                                       ▼
                  ┌─────────────────────────────────────────────┐
                  │              @siberflow/core                │
                  │                                             │
                  │   Agent ───── orkestrasi streaming loop     │
                  │     │                                       │
                  │     ├─ Provider     (chatStream)            │
                  │     ├─ ToolRegistry (eksekusi tool calls)   │
                  │     └─ Session      (persistensi history)   │
                  │                                             │
                  │   ToolContext: { projectDir } ─── sandbox   │
                  └────────────────────┬────────────────────────┘
                                       │ memanggil
                                       ▼
        ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────┐
        │  LLM API (SSE)   │  │  Sistem lokal    │  │  ~/.siberflow/     │
        │  (DeepSeek, dst) │  │  fs (sandboxed)  │  │  sessions/*.json   │
        └──────────────────┘  └──────────────────┘  └────────────────────┘
```

Tiga lapisan:

- **Interface layer** — bertanggung jawab untuk I/O ke user (REPL, HTTP, VSCode panel). Memiliki dependency ke `@siberflow/core`, tidak ke provider/tool tertentu.
- **Core layer** — `Agent` loop, message types, registry, session store. Tidak pernah mengakses jaringan langsung; akses filesystem hanya untuk session storage di `~/.siberflow/`.
- **Adapter layer** — implementasi konkret `Provider` (HTTP streaming ke LLM) dan `Tool` (fs/shell, sandboxed ke `projectDir`).

---

## 3. Struktur Repository

Monorepo dengan npm workspaces.

```
siberflow/
├── package.json              # workspace root; scripts: build, dev:cli, cli, clean
├── tsconfig.base.json        # shared compiler options (strict, NodeNext, ES2022, types:[node])
├── .env.example              # template variabel lingkungan
├── README.md                 # ringkasan untuk user
├── DEVELOPMENT.md            # dokumen ini
└── packages/
    ├── core/                       # @siberflow/core
    │   ├── package.json            # type: module, exports map, @types/node devDep
    │   ├── tsconfig.json           # composite: true (untuk project references)
    │   └── src/
    │       ├── index.ts            # re-export publik
    │       ├── agent/
    │       │   ├── types.ts        # Message, ToolCall, ChatRequest, StreamEvent, FinishReason, UsageStats
    │       │   ├── agent.ts        # class Agent (streaming tool-calling loop, history mgmt)
    │       │   └── index.ts
    │       ├── providers/
    │       │   ├── base.ts         # interface Provider (chatStream)
    │       │   ├── deepseek.ts     # DeepSeekProvider (SSE parser + tool-call delta accumulator)
    │       │   ├── registry.ts     # createProvider(name, config)
    │       │   └── index.ts
    │       ├── tools/
    │       │   ├── base.ts         # interface Tool, ToolContext { projectDir }
    │       │   ├── registry.ts     # class ToolRegistry
    │       │   ├── index.ts        # createDefaultRegistry()
    │       │   ├── file/
    │       │   │   ├── path-utils.ts  # resolveWithin() — sandbox-aware resolver
    │       │   │   ├── read.ts
    │       │   │   ├── write.ts
    │       │   │   ├── edit.ts
    │       │   │   ├── copy.ts
    │       │   │   ├── list.ts
    │       │   │   └── index.ts
    │       │   └── cli/
    │       │       ├── exec.ts     # spawn dengan cwd = projectDir
    │       │       └── index.ts
    │       ├── session/
    │       │   ├── types.ts        # Session, SessionSummary, SESSION_FORMAT_VERSION
    │       │   ├── store.ts        # save/load/list/delete/findByNameOrId
    │       │   └── index.ts
    │       └── config/
    │           └── index.ts        # loadConfigFromEnv() — termasuk SIBERFLOW_PROJECT_DIR
    └── cli/                        # @siberflow/cli
        ├── package.json            # bin: siberflow, devDeps @types/node tsx typescript
        ├── tsconfig.json           # references: [../core]
        ├── bin/siberflow.js
        └── src/
            ├── index.ts            # entry: load env, build provider+registry, run REPL
            ├── env.ts              # .env loader (walk-up parser, no dependency)
            ├── repl.ts             # interactive loop + slash commands + session lifecycle
            ├── tool-renderer.ts    # per-tool-call streaming renderer (raw forward)
            └── ui.ts               # warna terminal + formatting helpers
```

---

## 4. Konsep Inti

### 4.1 Message

Format internal yang sengaja dibuat **netral** dari provider tertentu. Setiap provider adapter bertanggung jawab menerjemahkan ke/dari format API spesifik vendor.

```ts
type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

interface ToolCall {
  id: string;       // ID dari provider untuk korelasi tool call ↔ tool result
  name: string;
  arguments: string; // JSON string — biarkan tool yang mem-parse
}
```

`arguments` disimpan sebagai **string**, bukan object. Ini cocok dengan cara semua API LLM major mengirim tool calls — tidak ada lossy round-trip serialization.

### 4.2 StreamEvent

Provider tidak mengembalikan response final; ia menghasilkan `AsyncIterable<StreamEvent>`. Empat varian:

```ts
type StreamEvent =
  | { type: "content"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; delta: string }
  | { type: "done"; message: AssistantMessage; finishReason: FinishReason; usage?: UsageStats };
```

- `content` — token natural language model
- `tool_call_start` — emit sekali per tool call saat `id` & `name` pertama diketahui
- `tool_call_args` — delta JSON args (potongan partial, accumulate untuk dapat full JSON)
- `done` — sinyal akhir; membawa pesan assistant lengkap (sudah ter-assemble dari deltas), finish reason, usage tokens

Provider menjamin urutan: `done` selalu terakhir. Antara `tool_call_start` dan `done` boleh ada banyak `tool_call_args` (untuk index yang sama) dan `tool_call_start` lain (untuk index berbeda, bila model panggil multiple tools).

### 4.3 Provider

```ts
interface Provider {
  readonly name: string;
  readonly defaultModel: string;
  chatStream(req: ChatRequest): AsyncIterable<StreamEvent>;
}
```

Provider tugasnya:

1. Terjemahkan internal `Message[]` → format API vendor.
2. POST request dengan `stream: true`.
3. Parse SSE chunks → yield `StreamEvent` apa adanya, tanpa buffer per-token.
4. Akumulasi internal untuk meng-assemble `AssistantMessage` final yang dilampirkan di event `done`.

Provider tidak melakukan eksekusi tool, tidak menyimpan state lintas request, dan tidak mengetahui agent loop.

### 4.4 Tool & ToolRegistry

```ts
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
  execute(args: unknown, ctx: ToolContext): Promise<string>;
}

interface ToolContext {
  projectDir: string;  // sandbox root
}
```

- `parameters` adalah **JSON Schema** — dikirim ke LLM agar tahu cara memanggil tool.
- `execute` selalu return **string** untuk diberikan kembali ke LLM. Kalau result kompleks, serialize JSON di dalam tool.
- `ToolContext.projectDir` adalah sandbox boundary. Setiap tool file harus memvalidasi path lewat `resolveWithin()` (lihat §4.6).

`ToolRegistry` adalah container in-memory: `register()`, `list()`, `get()`, `execute(name, rawArgs, ctx)`. `execute()` di registry juga menjadi titik terpusat untuk JSON parsing dan error catching — tool individual cukup throw `Error` biasa.

### 4.5 Agent Loop (streaming)

Class `Agent` adalah jantung orkestrasi. Pseudocode dari `agent.ts`:

```
send(userInput):
  messages.push({ role: "user", content: userInput })
  for i in 0..maxIterations:
    emit onAssistantStart()
    for await ev of provider.chatStream(...):
      switch ev.type:
        content        -> emit onContent(ev.delta)
        tool_call_start-> emit onToolCallStart(ev.index, ev.name)
        tool_call_args -> emit onToolCallArgs(ev.index, ev.delta)
        done           -> capture { assistant, finishReason, usage }
    messages.push(assistant)
    emit onAssistantEnd(assistant, { finishReason, usage })

    if finishReason !== "tool_calls":
      return assistant.content

    for (idx, call) in assistant.toolCalls:
      result = registry.execute(call.name, call.arguments, ctx)
      emit onToolResult(idx, call.name, result)
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result })

  return "(stopped after N iterations)"
```

Hal penting:

- **History dimaintain di dalam `Agent.messages`**, jadi `send()` bisa dipanggil berkali-kali dan model mengingat konteks. `loadHistory()` untuk restore dari session, `reset()` untuk clear (tapi pertahankan system prompt).
- **Tool calls dieksekusi serial**. Bisa di-paralelisasi nanti.
- **Events** adalah satu-satunya jendela ke proses. Interface layer memakainya untuk render; tidak ada interface yang perlu memodifikasi loop.
- **`maxIterations`** mencegah infinite loop saat model terus memanggil tool tanpa pernah memberi jawaban final.

#### AgentEvents API

```ts
interface AgentEvents {
  onAssistantStart?: () => void;                              // mulai turn baru
  onContent?: (delta: string) => void;                        // token text
  onToolCallStart?: (index: number, name: string) => void;    // model mulai panggil tool
  onToolCallArgs?: (index: number, delta: string) => void;    // chunk JSON args
  onAssistantEnd?: (msg: AssistantMessage, meta: {            // turn selesai (sebelum eksekusi tool)
    finishReason: FinishReason;
    usage?: UsageStats;
  }) => void;
  onToolResult?: (index: number, name: string, result: string) => void; // hasil eksekusi
}
```

`index` mengkorelasikan `onToolCallStart` ↔ `onToolCallArgs` ↔ `onToolResult` untuk multi-tool dalam satu turn.

### 4.6 Sandbox (Path Validation)

Helper inti: `resolveWithin(projectDir, p)` di [path-utils.ts](packages/core/src/tools/file/path-utils.ts):

```ts
async function resolveWithin(projectDir: string, p: string): Promise<string>
```

Algoritma:

1. Resolve `p` ke absolut (terhadap `projectDir` kalau relative).
2. `realpath()` — ikuti symlink. Untuk file yang belum ada (mis. tujuan `write_file`), realpath ancestor terdalam yang exist, lalu rangkai komponen yang missing.
3. `realpath()` juga `projectDir`.
4. `path.relative(projectReal, targetReal)` — kalau hasilnya mulai dengan `..` atau absolute → throw "Path is outside the project directory".

Yang diblokir:

| Pola | Hasil |
|---|---|
| `../escape` (relative naik) | ✗ |
| `/etc/hosts` (absolute luar) | ✗ |
| Symlink di dalam → file luar | ✗ (realpath dicek) |
| `subdir/foo.txt` | ✓ |
| `newdir/file.txt` (belum ada) | ✓ kalau parent terdalam ada di sandbox |

Tool `exec` adalah pengecualian: cwd-nya di-set ke `projectDir`, tapi shell command bisa secara teknis akses path luar lewat `$HOME`, `/tmp`, dll. Sandbox keras hanya berlaku untuk file tools. Untuk isolation keras perlu container.

### 4.7 Session Persistence

Module `@siberflow/core/session` ([packages/core/src/session/](packages/core/src/session/)). Storage: `~/.siberflow/sessions/<id>.json`, satu file per sesi.

```ts
interface Session {
  version: number;          // SESSION_FORMAT_VERSION = 1
  id: string;               // timestamp+random, juga = nama file
  name: string | null;      // user-given, optional
  projectDir: string;       // proyek mana
  provider: string;
  model: string;
  createdAt: string;        // ISO
  updatedAt: string;        // ISO
  messages: Message[];      // FULL history (termasuk system + tool results)
}
```

API:

| Fungsi | Keterangan |
|---|---|
| `saveSession(session)` | Tulis JSON, overwrite. Membuat dir kalau perlu. |
| `loadSession(id)` | Load by exact id. `null` kalau tidak ada. |
| `listSessions({ projectDir? })` | Summary semua sesi (atau filter project). Sorted by `updatedAt` desc. |
| `findByNameOrId(query, projectDir?)` | Match prioritas: name exact → id exact → id prefix. Dengan filter project. |
| `deleteSession(id)` | Return `true` kalau ada, `false` kalau ENOENT. |
| `newSessionId()` | Timestamp + 4-char random suffix. |

CLI memakainya untuk:

- **Startup**: panggil `listSessions({ projectDir })`, ambil index 0 (paling baru), `loadSession`, lalu `agent.loadHistory()`.
- **After turn**: tulis lengkap pakai `saveSession()`. Kalau turn error, tidak disimpan (state mungkin inconsistent karena assistant message tertulis tapi tool result belum).
- **Slash commands**: `/list`, `/new [name]`, `/load <name|id>`, `/name`, `/save`, `/delete`.

Filter `projectDir`: sesi yang dibuat di project lain tidak muncul di `/list` saat user buka project ini. Ini mencegah cross-project confusion (path file dalam history merefer ke project lain).

**Trade-off**: messages bisa membesar (tool result `read_file` membawa isi file penuh). Untuk personal use OK; kalau ratusan sesi dengan file besar, kandidat migrasi ke SQLite atau kompresi gzip.

---

## 5. Alur Eksekusi (Sequence)

Contoh: user mengetik `"buat file hello.txt isinya Hello World"`.

```
User              CLI                Agent             Provider            Tool          Session
 │ input           │                  │                   │                  │             │
 ├────────────────►│                  │                   │                  │             │
 │                 │ agent.send()     │                   │                  │             │
 │                 ├─────────────────►│                   │                  │             │
 │                 │                  │ chatStream()      │                  │             │
 │                 │                  ├──────────────────►│                  │             │
 │                 │ onAssistantStart │                   │                  │             │
 │                 │◄─────────────────┤                   │                  │             │
 │                 │ onContent("Baik")│ stream "Baik"     │                  │             │
 │                 │◄─────────────────┤◄──────────────────┤                  │             │
 │ "Baik..."       │                  │                   │                  │             │
 │◄────────────────┤                  │                   │                  │             │
 │                 │ onToolCallStart  │ tool_call_start   │                  │             │
 │                 │◄─────────────────┤◄──────────────────┤                  │             │
 │ ↳ tool write... │                  │                   │                  │             │
 │◄────────────────┤                  │                   │                  │             │
 │                 │ onToolCallArgs * │ tool_call_args *  │                  │             │
 │                 │◄─────────────────┤◄──────────────────┤                  │             │
 │ {"path":"...    │                  │                   │                  │             │
 │◄────────────────┤                  │                   │                  │             │
 │                 │ onAssistantEnd   │ done              │                  │             │
 │                 │◄─────────────────┤◄──────────────────┤                  │             │
 │                 │                  │ registry.execute  │                  │             │
 │                 │                  ├────────────────────────────────────► │             │
 │                 │                  │   "Wrote 11 bytes..."                │             │
 │                 │                  │◄──────────────────────────────────── │             │
 │                 │ onToolResult     │                   │                  │             │
 │                 │◄─────────────────┤                   │                  │             │
 │ Wrote 11 bytes  │                  │                   │                  │             │
 │◄────────────────┤                  │                   │                  │             │
 │                 │                  │ chatStream() #2   │                  │             │
 │                 │                  ├──────────────────►│                  │             │
 │                 │ onContent("OK")  │ stream + done     │                  │             │
 │                 │◄─────────────────┤◄──────────────────┤                  │             │
 │ "OK selesai"    │                  │                   │                  │             │
 │◄────────────────┤                  │                   │                  │             │
 │                 │ saveSession() ───────────────────────────────────────────────────────►│
 │                 │                  │                   │                  │   *.json    │
```

---

## 6. Komponen Bawaan

### 6.1 Providers

#### DeepSeek ([providers/deepseek.ts](packages/core/src/providers/deepseek.ts))

- Endpoint default: `https://api.deepseek.com/v1/chat/completions`
- Format wire: **OpenAI-compatible** + SSE streaming
- Request: kirim `stream: true` dan `stream_options: { include_usage: true }`
- Response parsing: SSE event terdelimit `\n\n`; tiap event berisi `data: {chunk}` atau `data: [DONE]`
- Tool call delta accumulator: tiap delta bisa membawa `id`, `name`, atau partial `arguments` — disimpan di `Map<index, ToolCall>` dan diemit sebagai `tool_call_start` (saat name+id pertama lengkap) + `tool_call_args` (tiap delta arguments).
- Model: `deepseek-chat` (default), `deepseek-reasoner`

Provider OpenAI / Groq / Together / vLLM tinggal copy-paste dengan ganti `baseUrl` dan `defaultModel`. Untuk Anthropic Messages API atau Gemini, terjemahan message format yang berbeda.

### 6.2 Tools

| Tool | Argumen | Catatan |
|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` | UTF-8. Sandboxed (`resolveWithin`). |
| `write_file` | `path`, `content` | Overwrite, bikin parent dir. Sandboxed. |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | Default fail kalau `old_string` ambigu. Sandboxed. |
| `copy_file` | `source`, `destination`, `overwrite?` | Sandbox dicek untuk source DAN destination. |
| `list_dir` | `path?` | Non-recursive. Default = `projectDir`. |
| `exec` | `command`, `timeout_ms?` | `/bin/sh -c <command>` dengan `cwd: projectDir`. Default timeout 120s, max 600s. Output ~200KB. **Tidak hard-sandboxed** — shell bisa akses path luar via $HOME dll. |

---

## 7. Konfigurasi

Semua via environment. CLI memuat `.env` di working directory, walk-up sampai filesystem root (sehingga `npm run dev:cli` dari mana saja menemukan `.env` di root project).

| Variabel | Default | Keterangan |
|---|---|---|
| `SIBERFLOW_PROVIDER` | `deepseek` | Nama provider |
| `SIBERFLOW_MODEL` | (default provider) | Model spesifik |
| `SIBERFLOW_BASE_URL` | (default provider) | Override endpoint API |
| `SIBERFLOW_PROJECT_DIR` | `INIT_CWD` → `process.cwd()` | Sandbox root. Absolute, relative, atau `~/...`. Divalidasi exists & is directory. |
| `DEEPSEEK_API_KEY` | — | Wajib kalau provider = deepseek |

Mapping nama provider → env var key ada di `config/index.ts` (`apiKeyEnvVar`). Saat menambah provider, tambahkan case-nya di sana.

**`INIT_CWD`**: npm men-set env ini ke directory tempat `npm run` dipanggil (sebelum chdir ke workspace). Tanpa ini, `npm run dev:cli` dari root project akan menghasilkan `projectDir = packages/cli/` yang salah.

---

## 8. Build & Development

### Setup pertama kali

```bash
npm install
cp .env.example .env         # isi DEEPSEEK_API_KEY (+ optional SIBERFLOW_PROJECT_DIR)
```

### Scripts root

| Script | Aksi |
|---|---|
| `npm run build` | Build `@siberflow/core` lalu `@siberflow/cli` (urutan eksplisit, bukan alphabetical) |
| `npm run dev:cli` | Jalankan CLI lewat `tsx` (no rebuild) |
| `npm run cli` | Jalankan CLI dari `dist/` (perlu build dulu) |
| `npm run clean` | Hapus semua `packages/*/dist` |

### TypeScript project references

`packages/cli/tsconfig.json` mereferensikan `packages/core` lewat `references: [{ path: "../core" }]`. Karena itu:

- `packages/core/tsconfig.json` punya `composite: true`.
- Root build eksplisit: `npm run build -w @siberflow/core && npm run build -w @siberflow/cli`. Tanpa ini, npm workspaces menjalankan dalam urutan alfabetik (cli sebelum core) sehingga cli memakai `.d.ts` core yang stale.
- Saat cek ulang stale incremental: hapus `*.tsbuildinfo` lalu `npm run clean && npm run build`.

Mode dev (`tsx`) tidak perlu build core dulu — transpile on-the-fly.

---

## 9. Cara Memperluas

### 9.1 Menambah Provider Baru

Karena interface sekarang streaming, semua provider harus implementasi `chatStream`.

**Step 1.** Buat `packages/core/src/providers/openai.ts`:

```ts
import type { Provider, ProviderConfig } from "./base.js";
import type { ChatRequest, StreamEvent } from "../agent/types.js";

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly defaultModel = "gpt-4o-mini";
  // constructor — sama dengan DeepSeek
  async *chatStream(req: ChatRequest): AsyncIterable<StreamEvent> {
    // 1. POST dengan stream: true ke openai.com
    // 2. Parse SSE (reuse parseSSE helper — pertimbangkan ekstrak ke shared)
    // 3. Akumulasi tool_calls, emit stream events
    // 4. Yield "done" terakhir
  }
}
```

Karena OpenAI dan DeepSeek formatnya identik, kandidat refactor: ekstrak `OpenAICompatibleProvider` base class dengan `protected baseUrl` saja yang di-override.

**Step 2.** Daftarkan di `providers/registry.ts`:

```ts
export type ProviderName = "deepseek" | "openai";
```

**Step 3.** Tambah mapping env var di `config/index.ts`.

Untuk provider dengan format berbeda (Anthropic Messages API, Gemini), bekerja keras ada di **terjemahan message format** dan **parser stream events** — sisanya sama.

### 9.2 Menambah Tool Baru

**Step 1.** Buat file tool:

```ts
// packages/core/src/tools/file/glob.ts
import type { Tool } from "../base.js";
import { resolveWithin } from "./path-utils.js";

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern (within project sandbox).",
  parameters: { /* JSON Schema */ },
  async execute(args, ctx) {
    // Pastikan setiap path divalidasi:
    // const base = await resolveWithin(ctx.projectDir, args.cwd ?? ".");
  },
};
```

**Aturan untuk tool yang menyentuh filesystem**: SELALU lewatkan path user-provided ke `resolveWithin(ctx.projectDir, path)` sebelum operasi.

**Step 2.** Tambah ke `fileTools[]` di `file/index.ts`. Otomatis terdaftar di `createDefaultRegistry()`.

**Konvensi penamaan**: `snake_case`. Description ditulis untuk LLM — jelaskan kapan dipakai dan apa argumennya.

### 9.3 Menambah Interface Baru

Pattern: interface mengkonsumsi `@siberflow/core`, mengelola sessions, dan mem-forward events ke UI.

Skeleton untuk web (Express + SSE) dengan session:

```ts
import {
  Agent, createDefaultRegistry, createProvider, loadConfigFromEnv,
  saveSession, loadSession, newSessionId, SESSION_FORMAT_VERSION,
} from "@siberflow/core";

const config = loadConfigFromEnv();
const provider = createProvider(config.provider, { apiKey: config.apiKey });
const registry = createDefaultRegistry();

const agents = new Map<string, { agent: Agent; sessionId: string }>();

app.post("/chat", async (req, res) => {
  let entry = agents.get(req.body.sessionId);
  if (!entry) {
    const agent = new Agent({ provider, registry, model: config.model, projectDir: config.projectDir });
    const existing = req.body.sessionId ? await loadSession(req.body.sessionId) : null;
    if (existing) agent.loadHistory(existing.messages);
    entry = { agent, sessionId: existing?.id ?? newSessionId() };
    agents.set(entry.sessionId, entry);
  }

  res.setHeader("Content-Type", "text/event-stream");

  await entry.agent.send(req.body.message, {
    onContent: (d) => res.write(`event: content\ndata: ${JSON.stringify(d)}\n\n`),
    onToolCallStart: (idx, name) => res.write(`event: tool_start\ndata: ${JSON.stringify({idx, name})}\n\n`),
    onToolCallArgs: (idx, d) => res.write(`event: tool_args\ndata: ${JSON.stringify({idx, d})}\n\n`),
    onToolResult: (idx, name, r) => res.write(`event: tool_result\ndata: ${JSON.stringify({idx, name, r})}\n\n`),
  });

  // persist after each turn
  await saveSession({
    version: SESSION_FORMAT_VERSION,
    id: entry.sessionId,
    name: null,
    projectDir: config.projectDir,
    provider: config.provider,
    model: config.model ?? provider.defaultModel,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [...entry.agent.history()],
  });

  res.end();
});
```

VSCode extension: sama, tapi event delivery via webview `postMessage`.

---

## 10. Roadmap

**Core**
- [x] Streaming response (default sekarang)
- [x] Persistensi history (multi-session JSON)
- [ ] Tool execution paralel kalau model mengirim multiple tool calls
- [ ] Cancellation (`AbortSignal` di seluruh stack)
- [ ] Permission system untuk tool destruktif (write/edit/exec) — model meminta izin, user approve di interface
- [ ] Better error envelope dari provider (rate limit, retry, network error)
- [ ] Token usage tracking + cost estimate per session

**Providers**
- [ ] OpenAI (mostly free karena format identik)
- [ ] Anthropic Messages API
- [ ] Gemini
- [ ] Refactor: `OpenAICompatibleProvider` base class

**Tools**
- [ ] `glob` pattern matching
- [ ] `grep` content search
- [ ] HTTP fetch
- [ ] Streaming output untuk `exec` (long-running command)
- [ ] `read_file` lazy loading — tidak masukkan isi penuh ke history kalau besar

**Sandbox / Security**
- [x] Path sandboxing untuk file tools
- [ ] Allow-list directory tambahan (multi-root sandbox)
- [ ] `SIBERFLOW_DISABLE_EXEC=true` untuk matikan exec
- [ ] Audit log tool calls

**Interfaces**
- [ ] `@siberflow/web` — Express/Fastify backend + minimal SPA
- [ ] `@siberflow/vscode` — extension dengan sidebar
- [ ] Slash command lebih lengkap (`/model`, `/provider`, `/clear`, `/export`)

**Session**
- [ ] Export sesi ke markdown
- [ ] Search across all sessions
- [ ] Migration helper antar `SESSION_FORMAT_VERSION`

**DX**
- [ ] Test suite (vitest)
- [ ] CI pipeline
- [ ] Logging structured (debug mode lewat env var)

---

## 11. Catatan Desain & Trade-off

**Mengapa monorepo + npm workspaces?**
Tiga interface (CLI/web/vscode) akan share `@siberflow/core`. Monorepo membuat refactor cross-package atomik dan menghindari publish-loop saat development. Pakai npm workspaces karena tanpa tooling tambahan; pnpm/turborepo bisa di-adopt nanti.

**Mengapa TypeScript NodeNext + ESM?**
- ESM adalah masa depan Node (dan VSCode extension host modern juga mendukung).
- `NodeNext` resolution memaksa import dengan ekstensi `.js` di source code — verbose tapi output `.js` jalan tanpa bundler.
- Strict mode + `noUncheckedIndexedAccess` menangkap bug `undefined` lebih awal.

**Mengapa streaming-only (`chatStream` saja, tidak ada `chat`)?**
- Internal agent loop sama-sama bisa menerima full response dengan streaming yang langsung di-collect.
- Tidak ada path code yang berbeda untuk streaming vs non-streaming → maintenance lebih rendah.
- Token latency lebih baik untuk semua interface (CLI live render, web SSE, vscode webview).

**Mengapa tool call args di-forward raw, tanpa parsing JSON?**
Versi awal parser per-field (`JsonStringFieldStreamer`) menahan output 50-100 byte di awal sambil scan key — perceptibly slow. Forward apa adanya = instant response. Trade-off: `\n` di content terlihat sebagai literal `\n`, bukan baris baru. Acceptable untuk visibility, bisa ditambah pretty-renderer optional di kemudian hari.

**Mengapa `fetch` built-in, bukan axios/got?**
Node 20+ punya `fetch` global. Tidak ada alasan menambah dependency 3rd party. Kalau perlu retry/interceptor, wrap di provider base class.

**Mengapa `arguments` di `ToolCall` adalah string, bukan object?**
Semua API LLM major mengirim function arguments sebagai JSON string. Kalau diparse jadi object dan re-serialize di provider adapter, ada risiko lossy round-trip (urutan key, format number). Lebih aman string-passthrough.

**Mengapa parser `.env` tulis sendiri, bukan `dotenv`?**
20 baris kode, zero dependency. Plus tambahan walk-up search agar `npm run -w` dari workspace tetap menemukan `.env` di root. Kalau nanti perlu variable expansion / multi-line, switch ke `dotenv`.

**Mengapa tool register manual, bukan auto-discovery?**
Auto-discovery (scan folder, import dinamis) gampang error dan susah di-debug. Manual register = single source of truth (`createDefaultRegistry()`) + trivial untuk testing (instansiasi registry kosong, register hanya tool yang dibutuhkan).

**Mengapa sesi simpan satu file per sesi (JSON), bukan SQLite?**
- Diff-friendly (bisa di-grep, di-edit manual)
- Zero dependency
- Cukup untuk personal use (puluhan-ratusan sesi)
- Migrasi ke SQLite di masa depan: tetap parsing JSON yang sama, tinggal pindahkan storage backend

**Mengapa filter `projectDir` di session listing?**
Path file di history (`tool_result` content, args dengan path absolut) merefer ke project original. Menampilkan sesi project lain saat user di project baru = confusing UX dan ngebuka error potensial saat AI re-execute path yang sudah tidak valid.

---

## 12. Catatan Keamanan

Status saat ini: **prototype, OK untuk single-user dev environment**.

### Yang sudah dilindungi

- **File tools sandboxed** ke `projectDir` lewat `resolveWithin()`. Symlink yang menunjuk ke luar di-block. Relative `..` ditolak. Absolute path luar ditolak.
- **`.env` di `.gitignore`** — API key tidak tergit-track.
- **Tool result truncation** (~200KB untuk exec) — mencegah membanjiri context window.

### Yang BELUM dilindungi

- **`exec` tool** menjalankan command apa pun di shell host. cwd di-set ke `projectDir` tapi shell bisa akses `$HOME`, `/tmp`, `cd /etc`. Cukup untuk dev environment satu user — jangan expose CLI ini sebagai service tanpa permission layer.
- **API key** disimpan plain text di env / `.env`. Untuk multi-user setup pakai secret manager.
- **Tidak ada audit log** untuk tool calls — hanya tampilan terminal yang ephemeral.
- **Tidak ada rate limit** untuk tool calls dalam satu sesi — model bisa loop sampai `maxIterations` (16).
- **Sesi `~/.siberflow/sessions/*.json`** tidak ter-encrypt. Berisi seluruh chat history dan kemungkinan konten file. File mode default (644). Jangan share folder ini.

### Threat model

| Skenario | Status |
|---|---|
| AI accidentally read/write file di luar project | ✓ Diblokir oleh sandbox |
| AI mengikuti symlink jahat keluar sandbox | ✓ Diblokir (realpath dicek) |
| AI menjalankan `rm -rf /` via exec | ✗ Tidak diblokir — operates dengan privilege user |
| User jahat menjalankan siberflow di shared machine | ✗ Bukan goal (asumsi single-user) |
| API key bocor lewat log | ✗ Mitigasi: jangan log full request body |

Sebelum merilis interface yang menerima input pihak ketiga (web public, extension share workspace), tambahkan minimal:
1. Tool permission scope per session (model minta izin, user approve)
2. `exec` opt-in, default off di mode multi-user
3. Audit log persisten
4. Rate limit & token quota per session
