import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

const extension = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
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
    await Promise.all([build(extension), build(webview)]);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
