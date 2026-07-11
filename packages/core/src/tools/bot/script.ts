import vm from "node:vm";
import type { Tool } from "../base.js";
import { assertNoShellLikeScriptAccess } from "../script-safety.js";

interface Args {
  script?: unknown;
}

export const botScriptTool: Tool = {
  name: "bot_script",
  description:
    "Run JavaScript against the active bot host (e.g. Telegram). The host injects a global `bot` " +
    "object for sending messages/media, running polls, sharing locations, and inspecting chat info.\n\n" +
    "Write TOP-LEVEL statements that call `bot.*` directly (do not wrap in a function and forget to call it).\n\n" +
    "bot.chat (read-only metadata of the active chat): id, type, title, username, messageThreadId, " +
    "currentMessageId, currentUserId, currentUserUsername.\n\n" +
    "Send actions (target the active chat by default; every send accepts an optional trailing `chatId` " +
    "to send elsewhere — cross-chat private sends require the user to have /start-ed the bot): " +
    "sendMessage(text, chatId?), sendPhoto/sendDocument/sendVideo/sendAudio/sendAnimation/sendVoice" +
    "(path, caption?, chatId?), sendMediaGroup(paths, caption?), sendLocation(lat, lng), " +
    "sendPoll(question, options, {multiple?, anonymous?}), reply(text). All return { message_id }.\n\n" +
    "Media paths must be inside the workdir. Shell/process access is blocked. Times out after 15 seconds.",
  parameters: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description:
          "JavaScript to run. The `bot` global is available: bot.chat, bot.sendMessage(text), " +
          "bot.sendPhoto(path, caption?), bot.sendDocument(path, caption?), etc.",
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

    // Detect the common mistake of writing an arrow function / function
    // declaration but never CALLING it. This is dead code — nothing runs, so
    // the bot does nothing yet the tool reports "completed". We catch it early
    // and give the model a clear error so it retries with top-level calls.
    const trimmed = script.trim();
    const looksLikeUnusedFunction =
      /^(async\s*)?\(.*\)\s*=>\s*\{/.test(trimmed) ||
      /^(async\s+)?function\s+\w+\s*\(/.test(trimmed) ||
      /^const\s+\w+\s*=\s*(async\s*)?\(.*\)\s*=>/.test(trimmed);
    if (looksLikeUnusedFunction) {
      throw new Error(
        "Your script defines a function but does not call it, so nothing runs. " +
          "Write TOP-LEVEL statements that call `bot.*` directly — e.g. " +
          "`const res = await bot.sendDocument('file.txt', 'caption'); return res;` " +
          "— NOT `async ({ bot }) => { ... }` or `const fn = async () => { ... }` without invoking it.",
      );
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
