// Preload: bridges the sandboxed renderer to the main process via a typed API.
// Uses contextBridge so the renderer only ever sees `window.siberflow`.

import { contextBridge, ipcRenderer } from "electron";
import type { MainEvent, RendererCalls } from "@shared/protocol";

const api: RendererCalls = {
  init: () => ipcRenderer.invoke("siberflow:init"),
  send: (input) => ipcRenderer.invoke("siberflow:send", input),
  stop: () => ipcRenderer.invoke("siberflow:stop"),
  regenerate: () => ipcRenderer.invoke("siberflow:regenerate"),
  editLast: (input) => ipcRenderer.invoke("siberflow:editLast", input),
  newSession: (folderPath, name) =>
    ipcRenderer.invoke("siberflow:newSession", folderPath, name),
  loadSession: (id) => ipcRenderer.invoke("siberflow:loadSession", id),
  deleteSession: (id) => ipcRenderer.invoke("siberflow:deleteSession", id),
  listSessions: (projectDir) =>
    ipcRenderer.invoke("siberflow:listSessions", projectDir),
  pickFolder: () => ipcRenderer.invoke("siberflow:pickFolder"),
  setWorkdir: (folderPath) => ipcRenderer.invoke("siberflow:setWorkdir", folderPath),
  pickDocFiles: () => ipcRenderer.invoke("siberflow:pickDocFiles"),
  answerUser: (id, status, answer) =>
    ipcRenderer.invoke("siberflow:answerUser", id, status, answer),
  getSettings: () => ipcRenderer.invoke("siberflow:getSettings"),
  saveSettings: (values, apiKey, multimodalApiKey) =>
    ipcRenderer.invoke("siberflow:saveSettings", values, apiKey, multimodalApiKey),
  renameSession: (id, name) =>
    ipcRenderer.invoke("siberflow:renameSession", id, name),
  getUsage: () => ipcRenderer.invoke("siberflow:getUsage"),
  onEvent: (callback) => {
    const listener = (_e: unknown, event: MainEvent): void => callback(event);
    ipcRenderer.on("siberflow:event", listener);
    return () => ipcRenderer.removeListener("siberflow:event", listener);
  },
};

contextBridge.exposeInMainWorld("siberflow", api);
