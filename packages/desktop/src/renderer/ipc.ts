// Typed wrapper around the preload-exposed `window.siberflow` API.
import type { RendererCalls } from "@shared/protocol";

declare global {
  interface Window {
    siberflow: RendererCalls;
  }
}

export const ipc = (): RendererCalls => window.siberflow;
