# Siberflow

AI platform dengan dukungan multi-provider, tool calling streaming, sandbox file, akses database, persistensi multi-session, dan task checklist. Interface saat ini: **CLI**, **VSCode extension** (sidebar panel), dan **Desktop app** (Electron + React).

Siberflow dikembangkan oleh **DataSiberLab**. Untuk pertanyaan, kerja sama, atau dukungan teknis, hubungi **candrapwr@datasiber.com**.

## Tampilan

**Desktop app — tampilan utama chat Siberflow.** Gambar ini menunjukkan aplikasi desktop dengan sidebar multi-session, area percakapan, composer, dan konteks kerja project.

![Siberflow Desktop App](./ss_desktop.png)

**Desktop settings — konfigurasi provider dan agent.** Di sini pengguna memilih provider, mengisi API key, mengatur custom OpenAI-compatible provider, model, tools, context optimization, dan opsi agent lain.

![Siberflow Desktop Settings](./ss_desktop_seting.png)

**Desktop ask tool — konfirmasi/pertanyaan dari agent.** Modal ini muncul ketika agent membutuhkan keputusan atau input pengguna sebelum melanjutkan pekerjaan.

![Siberflow Desktop Ask Tool](./ss_desktop_ask_tool.png)

**VSCode extension — chat AI langsung di sidebar editor.** Gambar ini menunjukkan panel Siberflow di VSCode yang berjalan dari konteks workspace.

![Siberflow VSCode Extension](./ss_vscode.png)

**CLI — mode terminal interaktif.** Gambar ini menunjukkan Siberflow berjalan sebagai REPL di terminal.

![Siberflow CLI](./ss_cli.png)

## Provider yang didukung

- `deepseek` (default) — `deepseek-v4-flash`, `deepseek-reasoner`
- `gemini` — `gemini-2.5-flash` (via endpoint OpenAI-compatible Google)
- `openai` — `gpt-5.4-nano` (pakai `/v1/chat/completions`)
- `openai-responses` — `gpt-5.1-codex-mini` (pakai `/v1/responses`; untuk codex / o-series / gpt-5 yang tidak didukung chat completions)
- `grok` — `grok-build-0.1` (xAI, via endpoint OpenAI-compatible)
- `qwen` — `qwen3.7-plus` (Alibaba DashScope / MaaS, OpenAI-compatible). Default endpoint internasional; custom MaaS workspace bisa override via `SIBERFLOW_BASE_URL`
- `zai` — `glm-5.2` (Z.AI / GLM, OpenAI-compatible). Default ke general endpoint `https://api.z.ai/api/paas/v4`; kalau perlu GLM Coding endpoint bisa override via `SIBERFLOW_BASE_URL`
- `claude` — `claude-sonnet-4-5` (Anthropic, via OpenAI-compatible chat completions endpoint)
- `custom` — provider OpenAI-compatible dengan nama, base URL, dan default model sendiri. Tersedia di Desktop, VSCode, dan CLI

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
# isi minimal salah satu API key: DEEPSEEK_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / XAI_API_KEY / DASHSCOPE_API_KEY / ZAI_API_KEY / ANTHROPIC_API_KEY / CUSTOM_API_KEY

npm run dev:cli
```

### Custom provider (OpenAI-compatible)

Gunakan `provider=custom` untuk provider yang kompatibel dengan OpenAI `/chat/completions`, misalnya proxy internal, OpenRouter-compatible endpoint, vLLM, LiteLLM, atau server sendiri.

Di **Desktop** dan **VSCode**, pilih `custom (OpenAI-compatible)` di settings, lalu isi:

- **Custom provider name** — nama tampilan/internal, misalnya `openrouter` atau `local-vllm`
- **Base URL** — root API, misalnya `https://api.example.com/v1`; Siberflow otomatis menambahkan `/chat/completions`
- **Default model** — model default saat field model override dikosongkan
- **API key** — disimpan encrypted seperti provider bawaan

Untuk **CLI**, pakai env:

```bash
SIBERFLOW_PROVIDER=custom
CUSTOM_API_KEY=...
SIBERFLOW_BASE_URL=https://api.example.com/v1
SIBERFLOW_CUSTOM_DEFAULT_MODEL=model-name
# opsional:
SIBERFLOW_CUSTOM_PROVIDER_NAME=my-provider
```

Jika ingin memakai model yang sama sebagai override eksplisit, `SIBERFLOW_MODEL` juga bisa dipakai. Base URL jangan diisi sampai path `/chat/completions`; cukup root API seperti `/v1`.

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

Untuk provider sendiri, pilih `custom (OpenAI-compatible)` lalu isi nama provider, base URL, default model, dan API key di settings panel.

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

Provider sendiri juga bisa ditambahkan dari settings modal dengan opsi `custom (OpenAI-compatible)`. Isi base URL root API dan default model; Siberflow akan memakai endpoint `/chat/completions`.

> **Error `Electron uninstall`?** Binary Electron (~180MB) tidak ter-download saat `npm install` (network/caching issue). Jalankan manual:
> ```bash
> node node_modules/electron/install.js
> ```
> Ini download Electron binary ke `node_modules/electron/dist/` + buat `path.txt`. Setelah itu `npm run dev:desktop` jalan normal. Catatan: `release:mac` tetap bisa tanpa ini karena electron-builder download Electron sendiri saat packaging.

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
- **Excel spreadsheet tool** — `excel_script`: satu tool serbaguna untuk membaca, memodifikasi, dan membuat `.xlsx` multi-sheet via akses penuh API `exceljs` di sandbox `node:vm`. Mendukung cells, **rumus/formula**, **gambar/image** (`addImage`/`getImages`), chart, merge cells, conditional formatting, autofilter, styling, dll. AI tulis function JS `(wb, ExcelJS) => { ... return <data> }`; host yang load/write file, sandbox hanya manipulasi workbook. File Excel dari upload UI disimpan di **OS tmp dir** (bukan project) — workspace tetap bersih, tidak ikut ke git
- **Word document tool** — `docx_script`: satu tool untuk membuat dan membaca `.docx` via library `docx` (create) + `mammoth` (read) di sandbox `node:vm`. Create mode: AI bangun dokumen deklaratif (heading, paragraf, tabel, image, bullet, styling) via `(doc, docx) => { ... }`; host serialize lewat `Packer.toBuffer`. Read mode: host convert `.docx` existing ke HTML via mammoth, teruskan ke script `(html) => { ... return data }` untuk ekstrak struktur/konten. Sandbox sync-only, host handle semua async I/O.
- **PDF document tool** — `pdf_script`: satu tool untuk membuat dan membaca `.pdf` via library `pdf-lib` (create) + `pdfjs-dist` (read) di sandbox `node:vm`. Create mode: AI bangun PDF deklaratif (halaman, text, shapes, warna, garis) via `(pdf, P, font) => { ... }`; host pre-embed Helvetica font + serialize lewat `pdf.save()`. Read mode: host ekstrak text semua halaman via pdfjs-dist, teruskan string (dipisah `\f` per halaman) ke script `(text) => { ... return data }`. **OCR mode** (`ocr:true`): untuk PDF gambar/scan, host render halaman → PNG (`pdfjs`+`@napi-rs/canvas`) lalu OCR via Tesseract lokal (`pytesseract`); text hasil OCR diteruskan ke script sama seperti read mode. Butuh tesseract di host.
- **Browser tool** — `run_browser` scrape/interaksi halaman web via headless Chrome/Edge (Puppeteer). Mendukung AJAX/SPA (render JS), klik/form/login, screenshot, intercept network, multi-tab. Script Puppeteer dijalankan di child process worker terisolasi dengan timeout kill. **Pakai Chrome/Edge yang sudah terinstall** — tidak ada download Chromium. Default OFF (opt-in)
- **Per-tool toggle** — aktif/nonaktifkan tool individual via settings/env (`SIBERFLOW_TOOLS`). Default hanya 5 file ops aktif; `exec`/`db_query`/`ssh`/`excel`/`docx`/`pdf`/`run_browser` opt-in untuk prompt ringan + blast-radius security kecil
- **Request delay (anti rate-limit)** — jeda sebelum setiap request ke AI (default 1500ms, bisa 0) untuk mencegah provider block saat loop tool-call cepat. Set via env (`SIBERFLOW_REQUEST_DELAY_MS`) atau settings UI
- **Task checklist** — opt-in via env / settings; AI maintain checklist multi-step yang bisa di-resume setelah Ctrl+C atau session restart
- **Context optimization** — buang tool history dari turn lama (default aktif); current task tetap utuh. Tiga mode via `SIBERFLOW_CONTEXT_OPTIMIZE_MODE`: `recent` (default; seperti summary, tapi sisakan 1 turn terakhir sebelum current turn tetap utuh — hanya turn yang lebih tua dikompres, jadi konteks tool terakhir tidak hilang dulu), `drop` (buang total), atau `summary` (sisakan tag `[SUMMARY]` berisi *signature* per tool — nama + identifier ringkas seperti `exec("df -h")` / `write_file("src/foo.ts")`; payload berat dan result tetap dibuang). Defense-in-depth: provider & serialization selalu menjamin assistant message punya content atau tool_calls (fix error 400 DeepSeek)
- **Auto-continue** — sambung otomatis respons yang kepotong max_tokens
- **Silent task_update** — tool `task_update` tetap dieksekusi tapi tidak ditampilkan di transcript (CLI, VSCode, Desktop); efeknya hanya terlihat di task checklist
- **Upload Excel dari chat (Desktop & VSCode)** — tombol paperclip di composer buka file picker `.xlsx` (multi-select); file disalin ke tmp per-session, prompt otomatis menyuruh AI baca via `excel_script`. Chip attachment dengan tombol hapus per file. Tombol disable otomatis saat `excel_script` tidak di-enable di settings
- **Multi-session** — sesi tersimpan per project, picker saat startup
- **Debug tracing** — env `SIBERFLOW_DEBUG=true` untuk log HTTP/finish_reason/usage
- **Custom provider** — Desktop/VSCode/CLI bisa memakai provider OpenAI-compatible sendiri lewat `custom`, dengan base URL dan default model yang bisa diatur pengguna

## Excel tool (`excel_script`)

Domain tool di `packages/core/src/tools/excel/excel-script.ts`, pakai library `exceljs` (pure JS, no native addon → aman untuk build Electron cross-platform). Terdaftar di registry di bawah flag `filesystem` — otomatis dimatikan saat session tanpa working directory (sama seperti `read_file`/`exec`).

Satu tool untuk semua operasi Excel: **baca**, **modifikasi**, dan **buat baru**. AI menyuplai function JavaScript `(wb, ExcelJS) => { ... return <optional data> }` yang dieksekusi di sandbox `node:vm`. Host yang melakukan semua I/O file (load source + write destination); sandbox hanya memanipulasi objek workbook, jadi akses filesystem tetap ter-sandbox.

### Mode operasi

- **Read existing** — beri `path` + `readOnly: true`. Workbook di-load dari disk, script membaca cell/rumus/image dari `wb` dan **return** data yang diekstrak. Return value (string/number/object/array) di-serialize ke JSON dan dikirim balik ke AI sebagai output tool, jadi AI "melihat" hasil bacaannya.
- **Modify existing** — beri `path` (workbook di-load ke `wb`), script memutasinya, hapus `readOnly`. Workbook ditulis balik ke `path` (atau `saveAs`) setelah script selesai.
- **Create new** — omit `path`, bangun workbook dari nol via `wb.addWorksheet(...)`, pass `saveAs` (atau `path`) sebagai destinasi. `wb` kosong baru disupply ke sandbox.

### Kapabilitas (full exceljs API)

- **Rumus/formula** — cell value `{ formula, result }`: baca `cell.value.formula` / `.result`, tulis `ws.getCell('C2').value = { formula: 'SUM(A2:A10)' }`.
- **Gambar/image** — `ws.getImages()` untuk enumerate image yang ada (buffer-nya via `wb.getImage(imageId).buffer`); tulis via `const id = wb.addImage({ buffer, extension:'png' }); ws.addImage(id, 'D2:F8')`. Catatan: sandbox mem-block `fs`, jadi untuk embed image AI harus baca bytes-nya dulu via tool lain (mis. `read_file`) lalu inline Buffer literal di script.
- **Styling** — font, fill, border, alignment, number format, freeze panes, zebra rows, dll.
- **Layout kompleks** — merge cells, multi-level header, conditional formatting, chart, autofilter, data validation, column grouping, protection.

### Keamanan sandbox

Sandbox `node:vm` locked-down: `require`/`process`/`fs`/`global`/`Promise`/`eval`/`Function` di-block, `codeGeneration.strings:false`, timeout 5 detik. Script **wajib synchronous** (API exceljs yang di-expose di sandbox semua sync; semua async I/O dilakukan host). Worker pattern: compile + invoke dalam satu `runInContext` supaya timeout cover infinite loop.

### Upload Excel dari UI (Desktop & VSCode)

Tombol paperclip 📎 di composer → file picker native `.xlsx` multi-select → file disalin ke **`os.tmpdir()/siberflow-uploads/<sessionId>/`** (per-session, mode 0700) → prompt otomatis digabung dengan list path file → AI pakai `excel_script`. Project folder tidak tersentuh. Saat session di-delete, folder tmp session otomatis dibersihkan (hook di `deleteSession`).

**Keamanan**: hanya `excel_script` yang whitelist upload dir (via `ToolContext.uploadDir`); tool file lain (`read_file`, `write_file`, `exec`, dll) tetap sandbox ke `projectDir` dan tidak bisa baca tmp.

## Browser tool (`run_browser`)

Tool scraping/interaksi halaman web via headless Chrome/Edge (Puppeteer). Default **OFF** — enable via settings (Desktop/VSCode) atau `SIBERFLOW_TOOLS` env (CLI).

**Cara kerja**: AI tulis function Puppeteer `async ({ page, browser }) => { ... }` → tool spawn **child process worker terisolasi** (bukan vm sandbox — Puppeteer async gak kompatibel) → worker launch Chrome atau Edge headless → run script → return result string. Worker di-kill kalau timeout (`timeoutMs` default 30s, max 60s). Reuse pattern kill tree dari `exec` (`process.kill(-pid)` Unix / `taskkill /T` Windows).

**Browser**: pakai Chrome/Edge yang sudah terinstall di sistem (channel `'chrome'` → fallback `'msedge'`). **Tidak ada download Chromium** — installer tetap kecil, langsung jalan.

**Output**: capped 200K chars (sama pattern `exec`/`db_query`). Tool description arahkan AI extract data spesifik (`$$eval`/`textContent`) daripada return raw HTML.

## Word document tool (`docx_script`)

Tool di `packages/core/src/tools/docx/docx-script.ts`, pakai library `docx` (create) dan `mammoth` (read) — keduanya pure JS, no native addon → aman untuk build Electron cross-platform. Terdaftar di registry di bawah flag `filesystem` — otomatis dimatikan saat session tanpa working directory (sama seperti `excel_script`/`read_file`/`exec`).

Satu tool untuk dua operasi: **create** dokumen baru dan **read** dokumen existing. AI menyuplai function JavaScript yang dieksekusi di sandbox `node:vm`. Host melakukan semua async I/O (load, mammoth conversion, Packer serialization, write) di luar sandbox; sandbox sync-only.

### Mode operasi

- **Create** — pass `saveAs` (atau `path`) sebagai destinasi. Script terima `(doc, docx)` di mana `doc` adalah fresh empty `Document` dan `docx` adalah module `docx`. Script membangun dokumen via API deklaratif (`doc.addSection({...})`, `new docx.Paragraph(...)`, dll). Host serialize via `docx.Packer.toBuffer(doc)` dan tulis ke destinasi.
- **Read** — pass `path` + `readOnly: true`. Host load `.docx`, convert ke HTML via mammoth, teruskan **HTML string** ke script `(html) => { ... return data }`. Script ekstrak apa yang dibutuhkan (heading, tabel, hitung kata, struktur) dan **return** datanya. Return value di-serialize JSON dan dikirim ke AI.

### Kapabilitas (Create mode — full `docx` library API)

- **Heading** — `docx.HeadingLevel.HEADING_1` sampai `HEADING_6` + `TITLE`.
- **Text styling** — `TextRun({ text, bold, italics, underline, color: 'FF0000', size: 24, font: 'Arial' })`. Size dalam half-points (24 = 12pt). Color hex tanpa `#`.
- **Bullet/numbering** — `Paragraph({ text, bullet: { level: 0 } })` atau numbering config.
- **Table** — `Table({ rows: [TableRow({ children: [TableCell({ children: [Paragraph('cell')] })] })] })`, dengan styling per-cell/row.
- **Image** — `ImageRun({ data: <Uint8Array>, transformation: { width, height } })`. Sandbox mem-block `fs` → untuk embed image, AI baca bytes dulu via tool lain (`read_file`) lalu inline Uint8Array di script.
- **Section/layout** — page size, margin, orientation, header/footer, page break, column.

### Kapabilitas (Read mode — mammoth HTML)

- **Struktur semantik** — heading (`<h1>`-`<h6>`), paragraf (`<p>`), tabel (`<table>`), list (`<ul>`/`<ol>`), bold/italic (`<strong>`/`<em>`).
- **Bukan exact formatting** — mammoth ekstrak struktur/konten, bukan styling visual (font, warna, margin tidak terbaca presisi). Ini limitasi mammoth, bukan bug.

### Keamanan sandbox

Sama seperti `excel_script`: sandbox `node:vm` locked-down, `require`/`process`/`fs`/`global`/`Promise`/`eval`/`Function` di-block, `codeGeneration.strings:false`, timeout 5 detik. Script wajib synchronous; semua async I/O dilakukan host di luar sandbox. Path destinasi (write) selalu sandbox `projectDir`; source path (read) whitelist `uploadDir` (uploaded files bisa dibaca).

## PDF document tool (`pdf_script`)

Tool di `packages/core/src/tools/pdf/pdf-script.ts`, pakai library `pdf-lib` (create) dan `pdfjs-dist` / Mozilla PDF.js (read) — keduanya pure JS, no native addon → aman untuk build Electron cross-platform. Terdaftar di registry di bawah flag `filesystem`.

Satu tool untuk dua operasi: **create** PDF baru dan **read** PDF existing. Pattern identik `excel_script`/`docx_script` (sandbox `node:vm` sync-only, host handle async I/O).

### Mode operasi

- **Create** — pass `saveAs` (atau `path`) sebagai destinasi. Script terima `(pdf, P, font)`:
  - `pdf` = fresh empty `PDFDocument` (pdf-lib)
  - `P` = module pdf-lib (`PDFDocument`, `StandardFonts`, `rgb`, `degrees`, `PageSizes`)
  - `font` = **pre-embedded Helvetica** — supaya script bisa `page.drawText(...)` langsung tanpa `await embedFont()` (yang async, blocked di sandbox)
  - Script bangun halaman (`pdf.addPage([w,h])` / `P.PageSizes.A4`), draw text/shapes, lalu host serialize via `pdf.save()` dan tulis ke destinasi.
- **Read** — pass `path` + `readOnly: true`. Host load PDF, ekstrak text semua halaman via pdfjs-dist, teruskan **string text** (dipisah `\f` per halaman) ke script `(text) => { ... return data }`. Split `text.split("\f")` untuk akses per halaman.

### Kapabilitas (Create mode — `pdf-lib` API)

- **Halaman** — `pdf.addPage([width, height])` (points) atau `pdf.addPage(P.PageSizes.A4)`. A4 = [595, 842].
- **Text** — `page.drawText('str', { x, y, size, font, color: P.rgb(r,g,b) })`. Color 0-1 float. `font` = pre-embedded Helvetica.
- **Shapes** — `page.drawRectangle({ x, y, width, height, color })`, `page.drawLine({ start, end, thickness })`, `page.drawEllipse(...)`.
- **Image** — terbatas: `embedPng`/`embedJpg` async, tidak bisa di sandbox. Saat ini create text/shape-only.
- **Multi-page** — `pdf.addPage()` per halaman baru, masing-masing independen.

### Kapabilitas (Read mode — pdfjs-dist)

- **Text extraction** — semua text layer dari setiap halaman, di-join dengan `\f` (form feed) sebagai separator.
- **Limitasi**: PDF hasil scan (image of text, no embedded text layer) return **empty** — pdfjs-dist tidak OCR, hanya baca text layer digital. PDF yang di-generate programatik (Word export, pdf-lib, dll) terekstrak baik.

### Mode OCR (untuk PDF gambar/scan)

Pass `ocr: true` untuk kenali text dari PDF yang berupa scan/foto. Host render tiap halaman jadi PNG resolusi tinggi (`pdfjs-dist` + `@napi-rs/canvas`, scale 2.0 ≈ 200 DPI) lalu OCR tiap PNG via Tesseract lokal (`pytesseract`). Text hasil OCR diteruskan ke script sama persis seperti read mode (`(text) => {...}`, dipisah `\f` per halaman). `ocrLanguage` pilih bahasa Tesseract (default `ind` Indonesia; `eng` English; `eng+ind` keduanya).

Prefer `readOnly: true` untuk PDF yang di-generate programatik — lebih cepat & akurat. OCR mode cuma worth it kalau PDF gak punya text layer asli.

OCR 100% lokal, **tanpa API key**, berbeda dari `analyze_image` yang kirim gambar ke model multimodal remote.

#### Prasyarat host OCR

```bash
# Python 3 + binding
pip install pytesseract Pillow

# Binary tesseract
sudo apt install tesseract-ocr          # Debian/Ubuntu
# brew install tesseract                # macOS
# choco install tesseract               # Windows
```

Kalau `pip install` gagal dengan `externally-managed-environment` (PEP 668, di macOS Homebrew Python + Linux modern), pakai `--break-system-packages` atau venv — detail lengkap & per-OS di [README.md → PDF OCR host prerequisites](README.md#note-on-externally-managed-environment-pep-668).

Override opsional:

```bash
SIBERFLOW_PDF_OCR_LANGUAGE=ind          # default (Indonesia); 'eng' English, 'eng+ind' keduanya
SIBERFLOW_PDF_OCR_TIMEOUT_MS=120000     # cap wall-clock per call OCR
```

Implementasi: `tools/pdf/pdf-script.ts` cabang `ocr:true`, helper `tools/ocr.ts` (`ocrImagesToText`, internal — bukan tool terpisah, supaya gak ambigu sama `analyze_image`), helper `tools/python-runner.ts` (shared `runPython`). Prasyarat host = dependency user (sama seperti voice tools butuh `python3`+`ffmpeg`), gak di-bundle. Catatan packaging VSIX/Desktop ada di `packages/core/src/tools/pdf/TODO-packaging.md`.

### Keamanan sandbox

Sama seperti `excel_script`/`docx_script`: sandbox `node:vm` locked-down, sync-only, host handle async I/O (`pdf.save()` create, `pdfjs.getDocument()` read). `pdfjs-dist` di-load lazy via `createRequire` di host (bukan di-bundle) untuk hindari masalah bundling ESM. Path destinasi sandbox `projectDir`; source path whitelist `uploadDir`.

## Per-tool toggle (enabledTools)

Aktif/nonaktifkan tool individual supaya tool yang gak dipakai gak membebani prompt (~200-300 token per disabled tool) + blast-radius security lebih ketat. Default: **hanya 5 file ops** aktif (`read_file`, `write_file`, `edit_file`, `copy_file`, `list_dir`). `exec`/`db_query`/`ssh_exec`/`sftp`/`excel_script`/`docx_script`/`run_browser` default OFF — opt-in. Pengecualian: `task_update` dan `ask_user` selalu on (core UX, tidak muncul di toggle).

`task_update` selalu nyala kalau `tasks` enabled (bypass enabledTools — itu master switch task checklist feature, bukan per-tool toggle).

| Interface | Cara set |
|---|---|
| **CLI** | env `SIBERFLOW_TOOLS=read_file,write_file,edit_file,copy_file,list_dir,run_browser` (comma-separated) |
| **VSCode** | setting `siberflow.enabledTools` (array) + grid checkbox di settings UI |
| **Desktop** | Settings modal → section "Tools" (grid 12+ checkbox, group by kategori) |

## Developer docs

Detail teknis, struktur kode, protokol VSCode extension, cara menambah provider/tool, dan internal rendering di [DEVELOPMENT.md](DEVELOPMENT.md).
