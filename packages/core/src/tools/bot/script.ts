import vm from "node:vm";
import type { Tool } from "../base.js";
import { assertNoShellLikeScriptAccess } from "../script-safety.js";

interface Args {
  script?: unknown;
}

export const botScriptTool: Tool = {
  name: "bot_script",
  description:
    "Run a small JavaScript automation script against the current bot host. " +
    "Use it for bot actions such as sending a message, photo, or document to the active chat/thread. " +
    "It does not provide file manipulation helpers; enable read_file/write_file/list_dir/etc. separately when file work is needed. " +
    "Shell/process access is blocked: child_process, execSync, spawn, require, dynamic import, process, eval, and Function are not allowed.",
  parameters: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description:
          "JavaScript body to run inside an async function. Available helper: bot.chat, bot.sendMessage(text), bot.sendPhoto(path, caption?), bot.sendDocument(path, caption?).",
      },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const script = (args as Args).script;
    if (typeof script !== "string" || !script.trim()) {
      throw new Error("bot_script requires a non-empty script string.");
    }
    assertNoShellLikeScriptAccess(script, "bot_script");
    if (!ctx.botScript) {
      throw new Error("bot_script is not available in this host.");
    }

    const logs: string[] = [];
    const sandbox = {
      bot: Object.freeze(ctx.botScript),
      console: {
        log: (...items: unknown[]) => logs.push(items.map(stringifyLogItem).join(" ")),
        warn: (...items: unknown[]) => logs.push(items.map(stringifyLogItem).join(" ")),
        error: (...items: unknown[]) => logs.push(items.map(stringifyLogItem).join(" ")),
      },
      require: undefined,
      process: undefined,
      Buffer: undefined,
      module: undefined,
      exports: undefined,
      __dirname: undefined,
      __filename: undefined,
      eval: undefined,
      Function: undefined,
      __result: undefined as unknown,
    };
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    const compiled = new vm.Script(
      `"use strict"; __result = (async () => {\n${script}\n})()`,
      { filename: "bot-script.js" },
    );

    compiled.runInContext(context, { timeout: 1000 });
    const result = await withTimeout(Promise.resolve(sandbox.__result), 15_000);
    const output = stringifyResult(result);
    const logText = logs.length ? `\nLogs:\n${logs.slice(-20).join("\n")}` : "";
    return `bot_script completed.${output ? `\nResult:\n${output}` : ""}${logText}`;
  },
};

function stringifyLogItem(item: unknown): string {
  if (typeof item === "string") return item;
  return stringifyResult(item);
}

function stringifyResult(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bot_script timed out.")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
