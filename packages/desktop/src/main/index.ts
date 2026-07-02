// Siberflow desktop — Electron main process entry.
// Owns the BrowserWindow, registers IPC, and wires the agent host.

import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc, getMainWindow, setMainWindow } from "./ipc.js";

// Override the app name so the OS (dock/menubar/taskbar) shows "Siberflow"
// instead of the generic "Electron" — matters in dev where the binary is
// literally named Electron.
app.setName("Siberflow");

// ESM-safe directory resolution. `__dirname` is a CommonJS global and is NOT
// defined when the main process is bundled/run as an ES module (which happens
// here because packages/desktop/package.json has "type": "module"). The
// portable replacement is import.meta.url → fileURLToPath → dirname. This
// works in both dev (tsx/electron-vite) and production (packaged app), and
// resolves to out/main in production so out/ is one level up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = join(__dirname, "..");

/** Resolve the app icon. Uses .icns on mac, .ico on win, .png otherwise. */
function iconPath(): string {
  const res = join(OUT_DIR, "..", "resources");
  const map =
    process.platform === "darwin"
      ? "icon.icns"
      : process.platform === "win32"
        ? "icon.ico"
        : "icon.png";
  const candidate = join(res, map);
  if (existsSync(candidate)) return candidate;
  // Fallback: png always exists (copied from vscode-ext).
  return join(res, "icon.png");
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: "Siberflow",
    backgroundColor: "#1e1e1e",
    icon: iconPath(),
    webPreferences: {
      preload: join(OUT_DIR, "preload", "index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    setMainWindow(mainWindow!);
    mainWindow?.show();
  });

  // Open external links in the default browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });

  // electron-vite: dev server URL in dev, local file in production.
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(OUT_DIR, "renderer", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS: apps stay active until explicitly quit.
  if (process.platform !== "darwin") app.quit();
});

export { getMainWindow };
