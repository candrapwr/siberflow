import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@siberflow/core"] })],
    build: {
      rollupOptions: {
        // Native modules must stay external — they are rebuilt for Electron's
        // ABI and cannot be bundled. @siberflow/core is bundled in.
        // `docx` / `mammoth` are ESM-only packages ("type":"module") that break
        // esbuild's CJS interop (TDZ on the `require2` helper) when bundled into
        // the Electron main's CJS output. Both ship CJS builds, so keep them
        // external and let Node resolve them at runtime — same as the native deps.
        external: ["ssh2", "sqlite3", "pg", "mysql2", "cpu-features", "puppeteer-core", "docx", "mammoth", "pdf-lib", "pdfjs-dist"],
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    plugins: [react()],
  },
});
