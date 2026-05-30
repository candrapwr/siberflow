import * as vscode from "vscode";
import { ChatViewProvider } from "./chat-panel.js";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  let provider: ChatViewProvider;
  try {
    provider = new ChatViewProvider(ctx);
  } catch (err) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("siberflow.openChat", () => provider.reveal()),
    vscode.commands.registerCommand("siberflow.newSession", () => provider.runCommand("new")),
    vscode.commands.registerCommand("siberflow.loadSession", () => provider.runCommand("load")),
    vscode.commands.registerCommand("siberflow.deleteSession", () => provider.runCommand("delete")),
    vscode.commands.registerCommand("siberflow.clearAllSessions", () => provider.runCommand("clearAll")),
    vscode.commands.registerCommand("siberflow.showUsage", () => provider.runCommand("usage")),
    vscode.commands.registerCommand("siberflow.showTools", () => provider.runCommand("tools")),
    vscode.commands.registerCommand("siberflow.openSettings", () => provider.runCommand("settings")),
  );
}

export function deactivate(): void {}
