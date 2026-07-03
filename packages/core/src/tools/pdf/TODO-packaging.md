# PDF OCR packaging TODO

This file tracks the packaging work needed to ship `pdf_script`'s OCR mode
(`ocr: true`) beyond the CLI / dev environment. OCR currently works in CLI/dev
on hosts where the prerequisites are installed; the remaining work is bundling
the render-time native binary into the VS Code extension and the desktop app.

## What OCR needs at runtime

The OCR pipeline (see `packages/core/src/tools/pdf/pdf-script.ts`, `ocr:true`
branch) has two stages:

1. **Render PDF → PNG** (Node side): `pdfjs-dist` + `@napi-rs/canvas`.
   - `@napi-rs/canvas` is an **optional dependency of `pdfjs-dist`**. It ships
     platform-specific prebuilt binaries (e.g. `@napi-rs/canvas-darwin-arm64`).
   - It is resolved at runtime via `createRequire(requireBaseUrl())`, mirroring
     how `extractPdfText` resolves `pdfjs-dist`.
   - If the binary for the current platform is missing, `renderPdfToImages`
     throws a clear error instructing `npm install @napi-rs/canvas`.

2. **OCR PNG → text** (Python side, host-installed): `pytesseract` + `tesseract`.
   - These are **host prerequisites the user installs** (same convention as the
     speech tools, which need `python3` + `ffmpeg`). They are **NOT bundled**
     into VSIX/desktop — see "Host prerequisites" below.

## Host prerequisites (user installs — do NOT bundle)

Identical model to the speech tools (`packages/core/src/tools/speech/voice.ts`):

```
pip install pytesseract Pillow
tesseract binary:  apt install tesseract-ocr | brew install tesseract | choco install tesseract
```

If any of these are missing, the OCR branch returns the full Python error as
the tool result so the model can explain the failure. No bundling work needed
here — these are documented in the tool description and `.env.example`.

## TODO: VS Code extension (`packages/vscode-ext`)

`@napi-rs/canvas` must be resolved at runtime, so it cannot be inlined by
esbuild. Follow the same pattern used for `puppeteer-core`, `pdfjs-dist`, etc.

1. Add `@napi-rs/canvas` to the `external` array in
   `packages/vscode-ext/esbuild.config.mjs`:
   ```js
   external: ["vscode", "puppeteer-core", "docx", "mammoth", "pdf-lib", "pdfjs-dist", "@napi-rs/canvas"],
   ```

2. Stage the prebuilt platform binary into the VSIX, mirroring
   `packages/vscode-ext/scripts/stage-puppeteer.mjs`:
   - Copy `@napi-rs/canvas` (and the relevant platform sub-package, e.g.
     `@napi-rs/canvas-darwin-arm64`, `...-win32-x64-msvc`, `...-linux-x64-gnu`)
     into `packages/vscode-ext/vendor/` (NOT `node_modules/` — `vsce` ignores
     `node_modules/`).
   - For cross-platform VSIX builds, stage all needed platform binaries.
   - At runtime, resolve `@napi-rs/canvas` from the extension's `vendor/` dir.
     The host can pass the path via an env var (like
     `SIBERFLOW_PUPPETEER_CORE_PATH`) OR the resolver in `pdf-script.ts` can be
     extended to scan `vendor/` — pick whichever matches the puppeteer-core
     resolution approach already in `browser.ts`.

3. Update `scripts/stage-puppeteer.mjs` (or add a sibling `stage-canvas.mjs`)
   wired into `prepackage`/`postpackage` so the vendor dir is populated for
   `vsce package` and cleaned up afterward.

## TODO: Desktop app (`packages/desktop`)

1. Add `@napi-rs/canvas` to the `external` array in
   `packages/desktop/electron.vite.config.ts` (alongside `pdfjs-dist`,
   `puppeteer-core`, etc.):
   ```js
   external: ["ssh2", "sqlite3", "pg", "mysql2", "cpu-features",
              "puppeteer-core", "docx", "mammoth", "pdf-lib",
              "pdfjs-dist", "@napi-rs/canvas"],
   ```

2. Because `electron-builder.yml` sets `asar: false` globally, the canvas
   binary files are packaged as ordinary files under the unpacked app dir — no
   `asarUnpack` entry is needed. Verify the platform binary lands next to the
   main `@napi-rs/canvas` JS so its `require()` of the platform sub-package
   resolves at runtime.

3. `@napi-rs/canvas` is pure prebuilt (not a node-gyp addon), so
   `electron-builder install-app-deps` / `npm run rebuild` is **not** required
   for it (it IS still required for `ssh2`, `sqlite3` as today).

4. For cross-platform desktop builds, build on the target OS (see the
   cross-platform build limitation table in the root `README.md`) so the
   correct platform binary is included.

## Validation checklist (after packaging)

- [ ] VS Code extension: `pdf_script {ocr:true}` works against a scanned PDF on
      a clean VSCode install with tesseract installed on the host.
- [ ] Desktop app: same, on a packaged `.dmg` / `.exe` / `.AppImage`.
- [ ] Error path: with tesseract missing, the tool returns a clear Python
      stderr, not a crash.
- [ ] Non-regression: `readOnly:true` on a text-layer PDF still works without
      any canvas/tesseract dependency.
