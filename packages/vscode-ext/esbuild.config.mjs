import { build, context } from "esbuild";
import { writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

// ssh2 optional-requires the native `cpu-features` binding for a minor
// speedup; it falls back to no-op when absent (wrapped in try/catch in
// ssh2/lib/protocol/constants.js). Since esbuild can't bundle a .node
// binary and we want a self-contained VSIX, we stub the module to a function
// returning undefined — ssh2's own try/catch accepts that and runs its
// pure-JS crypto path. Create the stub on disk so esbuild can resolve it.
const CPU_STUB_PATH = new URL("./dist/.cpu-features-stub.js", import.meta.url);
try {
  writeFileSync(CPU_STUB_PATH, "module.exports = () => undefined;\n");
} catch {
  // dist/ may not exist yet on a fresh checkout; esbuild creates it during
  // build, and the stub is only needed at bundle time below.
}
const cpuFeaturesStub = {
  name: "cpu-features-stub",
  setup(b) {
    b.onResolve({ filter: /^cpu-features$/ }, () => ({
      path: CPU_STUB_PATH.pathname,
      sideEffects: false,
    }));
  },
};

// ssh2 also optional-requires a native crypto binding (`sshcrypto.node`) in
// lib/protocol/crypto.js for hardware-accelerated ciphers. Same story: it's
// wrapped in try/catch and falls back to pure-JS crypto. We stub it to an
// empty module so esbuild can bundle ssh2 without a .node loader, and ssh2's
// own try/catch handles the missing binding at runtime.
const SSHCRYPTO_STUB_PATH = new URL("./dist/.sshcrypto-stub.js", import.meta.url);
try {
  writeFileSync(SSHCRYPTO_STUB_PATH, "module.exports = {};\n");
} catch {
  // dist/ may not exist yet; esbuild creates it during build.
}
const sshcryptoStub = {
  name: "sshcrypto-stub",
  setup(b) {
    b.onResolve({ filter: /build\/Release\/sshcrypto\.node$/ }, () => ({
      path: SSHCRYPTO_STUB_PATH.pathname,
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
  // puppeteer-core, docx, and mammoth are packages that must stay external.
  // puppeteer-core does dynamic requires at runtime. `docx` and `mammoth` are
  // ESM-only ("type":"module") and break esbuild's CJS interop (TDZ on the
  // generated `require2` helper) when bundled into the extension's CJS output.
  // Both ship CJS builds, so Node resolves them via require() at runtime.
  external: ["vscode", "puppeteer-core", "docx", "mammoth", "pdf-lib", "pdfjs-dist"],
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
