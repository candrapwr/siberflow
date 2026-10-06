import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles/global.css";

// Apply the last renderer theme before React mounts to avoid a bright flash
// while the persisted Desktop settings are loading over IPC.
const cachedTheme = localStorage.getItem("siberflow-theme");
document.documentElement.dataset.theme = cachedTheme === "light" ? "light" : "dark";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
