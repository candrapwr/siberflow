import { build, context } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");

// ssh2 optional-requires the native `cpu-features` binding for a minor
// speedup; it falls back to no-op when absent (wrapped in try/catch in
// ssh2/lib/protocol/constants.js). Since esbuild can't bundle a .node
// binary and we want a self-contained VSIX, we stub the module to a function
// returning undefined — ssh2's own try/catch accepts that and runs its
// pure-JS crypto path. Create the stub on disk so esbuild can resolve it.
//
// The stub lives under ./dist/, which may NOT exist yet on a fresh checkout
// (e.g. a clean server with no prior build). mkdirSync(recursive) ensures the
// directory exists BEFORE we write the stub — otherwise writeFileSync throws
// ENOENT, the catch swallows it, no stub file is created, and esbuild fails
// with "Cannot read file .cpu-features-stub.js" during bundling.
// Always convert file URLs to native filesystem paths before returning them
// from onResolve. URL.pathname produces `/D:/...` on Windows, which esbuild
// correctly rejects as a non-absolute Windows path.
const CPU_STUB_PATH = fileURLToPath(
  new URL("./dist/.cpu-features-stub.js", import.meta.url),
);
mkdirSync(dirname(CPU_STUB_PATH), { recursive: true });
writeFileSync(CPU_STUB_PATH, "module.exports = () => undefined;\n");
const cpuFeaturesStub = {
  name: "cpu-features-stub",
  setup(b) {
    b.onResolve({ filter: /^cpu-features$/ }, () => ({
      path: CPU_STUB_PATH,
      sideEffects: false,
    }));
  },
};

// ssh2 also optional-requires a native crypto binding (`sshcrypto.node`) in
// lib/protocol/crypto.js for hardware-accelerated ciphers. Same story: it's
// wrapped in try/catch and falls back to pure-JS crypto. We stub it to an
// empty module so esbuild can bundle ssh2 without a .node loader, and ssh2's
// own try/catch handles the missing binding at runtime.
const SSHCRYPTO_STUB_PATH = fileURLToPath(
  new URL("./dist/.sshcrypto-stub.js", import.meta.url),
);
mkdirSync(dirname(SSHCRYPTO_STUB_PATH), { recursive: true });
writeFileSync(SSHCRYPTO_STUB_PATH, "module.exports = {};\n");
const sshcryptoStub = {
  name: "sshcrypto-stub",
  setup(b) {
    b.onResolve({ filter: /build\/Release\/sshcrypto\.node$/ }, () => ({
      path: SSHCRYPTO_STUB_PATH,
      sideEffects: false,
    }));
  },
};

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  plugins: [cpuFeaturesStub, sshcryptoStub],
};

const extension = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  // Only vscode (provided by the host) and puppeteer-core stay external.
  // puppeteer-core does dynamic requires at runtime and is staged into the
  // VSIX under vendor/ (see scripts/stage-puppeteer.mjs) + resolved by path.
  // docx/mammoth (and the formerly-external pdf-lib/pdfjs-dist, now unused in
  // JS since PDF OCR moved to Python) ARE bundled here so the VSIX is
  // self-contained — vsce runs with --no-dependencies, so anything left
  // external but NOT staged would crash activation with "Cannot find module".
  // docx/mammoth are static-imported at the top of docx-script.ts, so they
  // load on extension activation, not just when the tool runs.
  external: ["vscode", "puppeteer-core"],
};

const webview = {
  ...common,
  entryPoints: ["webview/main.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
};

async function run() {
  if (watch) {
    const ctxExt = await context(extension);
    const ctxView = await context(webview);
    await Promise.all([ctxExt.watch(), ctxView.watch()]);
    console.log("watching…");
  } else {
    await build(extension);
    await build(webview);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
