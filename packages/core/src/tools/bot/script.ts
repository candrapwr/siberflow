import vm from "node:vm";
import type { Tool } from "../base.js";
import { assertNoShellLikeScriptAccess } from "../script-safety.js";

interface Args {
  script?: unknown;
}

export const botScriptTool: Tool = {
  name: "bot_script",
  description:
    "Run JavaScript automation against the active bot host (e.g. the Telegram bot). " +
    "Write any JS; the host injects a `bot` helper. Use it to send messages and media, " +
    "run polls, share locations, edit/delete the bot's own messages, and inspect chat info.\n\n" +
    "# IMPORTANT — how to write the script\n" +
    "Write TOP-LEVEL STATEMENTS that CALL `bot.*` directly. Do NOT wrap your code in a " +
    "function and forget to call it. `bot` is a GLOBAL available in the script scope.\n\n" +
    "CORRECT:\n" +
    "  const res = await bot.sendDocument('file.txt', 'caption');\n" +
    "  return res;\n\n" +
    "WRONG (creates a function but never calls it — nothing happens):\n" +
    "  async ({ bot }) => { await bot.sendDocument(...); }\n" +
    "  const send = async () => { await bot.sendDocument(...); }  // missing send()\n\n" +
    "# Available helpers (the `bot` object)\n" +
    "## bot.chat (read-only metadata of the ACTIVE chat)\n" +
    "- bot.chat.id — active chat id (group/supergroup/private)\n" +
    "- bot.chat.type — 'private' | 'group' | 'supergroup'\n" +
    "- bot.chat.title — group title (if any)\n" +
    "- bot.chat.username — chat @username (if any)\n" +
    "- bot.chat.messageThreadId — forum thread id (if any)\n" +
    "- bot.chat.currentMessageId — the user message id that triggered this turn\n" +
    "- bot.chat.currentUserId — the id of the user who sent the current message\n" +
    "- bot.chat.currentUserUsername — that user's @username (if any)\n\n" +
    "## Send actions (target the active chat by default; pass an explicit chatId to send elsewhere)\n" +
    "Every send action accepts an OPTIONAL last argument `chatId` (a number) to override the " +
    "destination. This enables cross-chat sends — e.g. a user in a GROUP asks you to send them " +
    "something in PRIVATE: use bot.chat.currentUserId as the chatId. IMPORTANT: cross-chat sends " +
    "to a private chat only work if that user has already /start-ed the bot in private; otherwise " +
    "Telegram returns a 'Forbidden' error, which you should explain to the user.\n" +
    "- bot.sendMessage(text, chatId?) -> { message_id }\n" +
    "- bot.sendPhoto(path, caption?, chatId?) -> { message_id }   (image file from the workdir)\n" +
    "- bot.sendDocument(path, caption?, chatId?) -> { message_id } (any file from the workdir)\n" +
    "- bot.sendVideo(path, caption?, chatId?) -> { message_id }\n" +
    "- bot.sendAudio(path, caption?, chatId?) -> { message_id }   (shown in the music player)\n" +
    "- bot.sendAnimation(path, caption?, chatId?) -> { message_id } (GIF)\n" +
    "- bot.sendVoice(path, caption?, chatId?) -> { message_id }   (.ogg voice message)\n" +
    "- bot.sendMediaGroup(paths, caption?) -> { messages: [...] } (album of 2-10 photos/videos)\n" +
    "- bot.sendLocation(latitude, longitude) -> { message_id }\n" +
    "- bot.sendPoll(question, options, { multiple?, anonymous? }) -> { message_id } (options = 2-10 strings)\n" +
    "- bot.reply(text) -> { message_id } (answers the current user in the active chat)\n\n" +
    "## Message manipulation (active chat only)\n" +
    "- bot.editMessageText(messageId, text) — edit one of the bot's OWN messages\n" +
    "- bot.deleteMessage(messageId) — delete a message in the active chat\n\n" +
    "## Chat info (active chat only)\n" +
    "- bot.getChat() — chat info (title, type, member count, etc.)\n" +
    "- bot.getChatMember(userId) — a member's status and user info\n\n" +
    "# Rules\n" +
    "- All media file paths MUST point inside the session workdir (relative paths work). " +
    "Paths escaping the workdir are rejected. To create/modify files, enable read_file/write_file/etc.\n" +
    "- Chat-info and message-manipulation actions (getChat, getChatMember, editMessageText, " +
    "deleteMessage, reply) ALWAYS operate on the active chat and ignore any chatId override.\n" +
    "- Admin/moderation actions (ban/kick/mute/promote members, set chat title, etc.) are NOT " +
    "available — do not attempt them.\n" +
    "- console.log/warn/error is available; logged lines are returned to you under 'Logs:'.\n" +
    "- Shell/process access is blocked: child_process, execSync, spawn, require, dynamic import, " +
    "process, eval, and Function are not allowed.\n" +
    "- Execution is sandboxed and times out after 15 seconds.",
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

    // Log the script body so the admin can see EXACTLY what the AI ran inside
    // the sandbox (via pm2/server logs). Truncated to keep the log readable.
    console.log(
      `[bot_script run] executing (${script.length} chars): ` +
        script.slice(0, 300).replace(/\n/g, " ⏎ ") +
        (script.length > 300 ? " …(truncated)" : ""),
    );

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
