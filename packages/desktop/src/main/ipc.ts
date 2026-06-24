// IPC handler registration: maps renderer calls to the AgentHost.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { AgentHost } from "./agent-host.js";
import type { MainEvent, SettingsValues } from "@shared/protocol";

let host: AgentHost | null = null;
let mainWindow: BrowserWindow | null = null;

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Broadcast a streaming event from the agent host to the renderer. */
function emit(event: MainEvent): void {
  mainWindow?.webContents.send("siberflow:event", event);
}

export function registerIpc(): void {
  host = new AgentHost(emit);

  ipcMain.handle("siberflow:init", async () => {
    await host!.init();
  });

  ipcMain.handle("siberflow:send", async (_e, input: string) => {
    await host!.send(input);
  });

  ipcMain.handle("siberflow:stop", () => {
    host!.stop();
  });

  ipcMain.handle("siberflow:regenerate", async () => {
    await host!.regenerate();
  });

  ipcMain.handle("siberflow:editLast", async (_e, input: string) => {
    await host!.editLast(input);
  });

  ipcMain.handle(
    "siberflow:newSession",
    async (_e, folderPath: string | null, name: string | null) => {
      return host!.startNewSession(folderPath, name);
    },
  );

  ipcMain.handle("siberflow:loadSession", async (_e, id: string) => {
    await host!.loadSessionById(id);
  });

  ipcMain.handle("siberflow:deleteSession", async (_e, id: string) => {
    await host!.deleteSessionById(id);
  });

  ipcMain.handle("siberflow:listSessions", async (_e, projectDir?: string) => {
    return host!.listSessions(projectDir);
  });

  ipcMain.handle("siberflow:pickFolder", async () => {
    const focused = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = await dialog.showOpenDialog(focused!, {
      title: "Select project folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  ipcMain.handle("siberflow:setWorkdir", async (_e, folderPath: string) => {
    host!.setWorkdir(folderPath);
  });

  ipcMain.handle("siberflow:pickExcelFiles", async () => {
    if (!host!.getWorkdir()) {
      return { error: "Pilih folder project dulu sebelum upload file." } as const;
    }
    const focused = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = await dialog.showOpenDialog(focused!, {
      title: "Pilih file Excel",
      filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { files: [] } as const;
    }
    try {
      const files = await host!.copyUploads(result.filePaths);
      return { files } as const;
    } catch (err) {
      return { error: (err as Error).message } as const;
    }
  });

  ipcMain.handle("siberflow:getSettings", () => {
    return host!.getSettings();
  });

  ipcMain.handle(
    "siberflow:saveSettings",
    async (_e, values: SettingsValues, apiKey: string | null) => {
      host!.saveSettings(values, apiKey);
    },
  );

  ipcMain.handle("siberflow:renameSession", async (_e, id: string, name: string) => {
    await host!.renameSession(id, name);
  });

  ipcMain.handle(
    "siberflow:answerUser",
    async (_e, id: string, status: "answer" | "cancel", answer: string) => {
      host!.resolveUserAnswer(id, status, answer);
    },
  );

  ipcMain.handle("siberflow:getUsage", () => {
    return host!.getUsage();
  });

  // Clean up the agent on quit so in-flight turns are stopped.
  app.on("before-quit", () => {
    host?.stop();
  });
}
