import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { marked } from "marked";
import {
  Agent,
  buildSystemPrompt,
  createDefaultRegistry,
  createProvider,
  deleteSession,
  loadConfigFromEnv,
  loadSession,
  optimizeContext,
  saveOptimizedMiddleView,
  saveOptimizedView,
  saveSession,
  SESSION_FORMAT_VERSION,
  type Provider,
  type Session,
  type ToolRegistry,
  type UsageStats,
} from "@siberflow/core";
import { loadDotEnv } from "./env.js";

type ChatType = "private" | "group" | "supergroup" | "channel";

interface TelegramChat {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  username?: string;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMedia {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
  width?: number;
  height?: number;
}

interface TelegramTextQuote {
  text: string;
  position?: number;
  is_manual?: boolean;
}

interface TelegramExternalReplyInfo {
  message_id?: number;
  chat?: TelegramChat;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  sticker?: TelegramMedia & { emoji?: string; set_name?: string };
  animation?: TelegramMedia & { file_name?: string };
  video?: TelegramMedia & { file_name?: string };
  voice?: TelegramMedia;
  audio?: TelegramMedia & { file_name?: string; title?: string; performer?: string };
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  reply_to_message?: TelegramMessage;
  external_reply?: TelegramExternalReplyInfo;
  quote?: TelegramTextQuote;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  sticker?: TelegramMedia & { emoji?: string; set_name?: string };
  animation?: TelegramMedia & { file_name?: string };
  video?: TelegramMedia & { file_name?: string };
  voice?: TelegramMedia;
  audio?: TelegramMedia & { file_name?: string; title?: string; performer?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface RuntimeSession {
  agent: Agent;
  session: Session;
  busy: boolean;
  pendingUsage?: UsageStats;
}

interface BotScriptState {
  message: TelegramMessage | null;
  workdir: string | null;
}

interface AppConfig {
  telegramToken: string;
  telegramApiBase: string;
  workdirRoot: string;
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  requestDelayMs: number;
  maxIterations: number;
  autoContinue: boolean;
  contextOptimize: ReturnType<typeof loadConfigFromEnv>["contextOptimize"];
}

const DRAFT_MIN_INTERVAL_MS = 900;
const FINAL_MAX_CHARS = 3900;

async function main(): Promise<void> {
  await loadDotEnv();
  const config = loadAppConfig();
  await mkdir(config.workdirRoot, { recursive: true });

  const api = new TelegramApi(config.telegramToken, config.telegramApiBase);
  const runner = new BotRunner(api, config);
  await runner.run();
}

function loadAppConfig(): AppConfig {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN.");
  }

  const coreConfig = loadConfigFromEnv(withTelegramProviderEnv());
  const provider = createProvider(coreConfig.provider, {
    apiKey: coreConfig.apiKey,
    ...(coreConfig.baseUrl ? { baseUrl: coreConfig.baseUrl } : {}),
    ...(coreConfig.customProviderName
      ? { customName: coreConfig.customProviderName }
      : {}),
    ...(coreConfig.customDefaultModel
      ? { customDefaultModel: coreConfig.customDefaultModel }
      : {}),
  });

  const registry = createDefaultRegistry({
    enabledTools: resolveTelegramTools(),
    tasks: false,
    interaction: false,
  });

  return {
    telegramToken,
    telegramApiBase:
      process.env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org",
    workdirRoot: resolve(
      expandHome(
        process.env.SIBERFLOW_TELEGRAM_WORKDIR_ROOT ??
          join(homedir(), ".siberflow", "telegram-workdirs"),
      ),
    ),
    provider,
    registry,
    model: coreConfig.model ?? provider.defaultModel,
    requestDelayMs: coreConfig.requestDelayMs,
    maxIterations: coreConfig.maxIterations,
    autoContinue: coreConfig.autoContinue,
    contextOptimize: coreConfig.contextOptimize,
  };
}

function withTelegramProviderEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (env.SIBERFLOW_TELEGRAM_PROVIDER !== undefined) {
    out.SIBERFLOW_PROVIDER = env.SIBERFLOW_TELEGRAM_PROVIDER;
  }
  const provider = out.SIBERFLOW_PROVIDER ?? "deepseek";
  copyTelegramEnv(out, env, "SIBERFLOW_MODEL", "SIBERFLOW_TELEGRAM_MODEL");
  copyTelegramEnv(out, env, "SIBERFLOW_BASE_URL", "SIBERFLOW_TELEGRAM_BASE_URL");
  copyTelegramEnv(
    out,
    env,
    "SIBERFLOW_CUSTOM_PROVIDER_NAME",
    "SIBERFLOW_TELEGRAM_CUSTOM_PROVIDER_NAME",
  );
  copyTelegramEnv(
    out,
    env,
    "SIBERFLOW_CUSTOM_DEFAULT_MODEL",
    "SIBERFLOW_TELEGRAM_CUSTOM_DEFAULT_MODEL",
  );
  const telegramApiKey = env.SIBERFLOW_TELEGRAM_API_KEY;
  if (telegramApiKey !== undefined) {
    out[apiKeyEnvVarForTelegramProvider(provider)] = telegramApiKey;
  }
  return out;
}

function copyTelegramEnv(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  globalName: string,
  telegramName: string,
): void {
  const value = source[telegramName];
  if (value !== undefined) target[globalName] = value;
}

function apiKeyEnvVarForTelegramProvider(provider: string): string {
  switch (provider) {
    case "gemini":
      return "GEMINI_API_KEY";
    case "openai":
    case "openai-responses":
      return "OPENAI_API_KEY";
    case "grok":
      return "XAI_API_KEY";
    case "qwen":
      return "DASHSCOPE_API_KEY";
    case "zai":
      return "ZAI_API_KEY";
    case "claude":
      return "ANTHROPIC_API_KEY";
    case "custom":
      return "CUSTOM_API_KEY";
    case "deepseek":
    default:
      return "DEEPSEEK_API_KEY";
  }
}

function resolveTelegramTools(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.SIBERFLOW_TELEGRAM_TOOLS;
  if (raw === undefined) return new Set(["run_browser"]);
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(names);
}

class BotRunner {
  private offset = 0;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly activeTurn = new AsyncLocalStorage<BotScriptState>();
  private botId = 0;
  private botUsername = "";

  constructor(
    private readonly api: TelegramApi,
    private readonly config: AppConfig,
  ) {}

  async run(): Promise<void> {
    const me = await this.api.getMe();
    this.botId = me.id;
    this.botUsername = me.username ?? "";
    console.log(
      `Siberflow Telegram bot started as @${me.username ?? me.first_name}.`,
    );
    console.log(`Workdir root: ${this.config.workdirRoot}`);
    console.log(`Enabled tools: ${this.config.registry.list().map((t) => t.name).join(", ")}`);

    for (;;) {
      try {
        const updates = await this.api.getUpdates(this.offset, 25);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          void this.handleUpdate(update).catch((err) =>
            console.error(`Telegram update error: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        console.error(`Telegram polling error: ${(err as Error).message}`);
        await sleep(2000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) return;
    if (message.chat.type === "channel") return;
    const messageText = message.text ?? message.caption ?? "";
    if (!messageText) return;

    if (isCommand(messageText, "start")) {
      await this.clearSessionFiles(message);
      await this.sendStartMessage(message);
      return;
    }

    if (isCommand(messageText, "reset")) {
      await this.resetSession(message);
      return;
    }

    const baseInput = this.normalizeIncomingInput(message);
    if (!baseInput) return;

    const runtime = await this.getRuntime(message);
    const input = await this.withReplyContext(message, baseInput, runtime.session.projectDir);
    if (!input) return;

    if (runtime.busy) {
      await this.api.sendMessage({
        chat_id: message.chat.id,
        text: "Session ini masih memproses pesan sebelumnya.",
        message_thread_id: message.message_thread_id,
      });
      return;
    }

    runtime.busy = true;
    try {
      await this.runTurn(runtime, message, input);
    } finally {
      runtime.busy = false;
    }
  }

  private normalizeIncomingInput(message: TelegramMessage): string {
    const text = message.text ?? message.caption ?? "";
    if (message.chat.type === "private") return normalizeInput(text);

    const commandInput = stripCommand(text);
    if (commandInput !== null) return commandInput;

    const mentionInput = stripBotMention(text, this.botUsername);
    if (mentionInput !== null) return mentionInput;

    if (message.reply_to_message) {
      return text.trim();
    }

    return "";
  }

  private async withReplyContext(
    message: TelegramMessage,
    input: string,
    workdir: string,
  ): Promise<string> {
    const replyImage = await this.downloadMessageImage(message.reply_to_message, workdir);
    const directImage = await this.downloadMessageImage(message, workdir);
    return withTelegramImageContext(message, input, {
      replyImagePath: replyImage,
      directImagePath: directImage,
    });
  }

  private async downloadMessageImage(
    message: TelegramMessage | undefined,
    workdir: string,
  ): Promise<string | undefined> {
    if (!message) return undefined;

    let fileId: string | undefined;
    let originalName = "telegram-image";
    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1]!;
      fileId = largest.file_id;
      originalName = `photo-${message.message_id}.jpg`;
    } else if (message.document?.mime_type?.startsWith("image/")) {
      fileId = message.document.file_id;
      originalName = message.document.file_name ?? `image-${message.message_id}`;
    }
    if (!fileId) return undefined;

    try {
      const data = await this.api.downloadFile(fileId);
      const dir = join(workdir, "_telegram");
      await mkdir(dir, { recursive: true });
      const safeName = sanitizeLocalFileName(originalName, message.message_id);
      const path = join(dir, safeName);
      await writeFile(path, data);
      return path;
    } catch (err) {
      console.error(`Telegram image download error: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async getRuntime(message: TelegramMessage): Promise<RuntimeSession> {
    const id = sessionIdFor(message);
    const cached = this.sessions.get(id);
    if (cached) return cached;

    const loaded = await loadSession(id);
    const now = new Date().toISOString();
    const workdir = join(this.config.workdirRoot, id);
    await mkdir(workdir, { recursive: true });

    const session: Session =
      loaded ??
      {
        version: SESSION_FORMAT_VERSION,
        id,
        name: sessionNameFor(message.chat),
        projectDir: workdir,
        provider: this.config.provider.name,
        model: this.config.model,
        createdAt: now,
        updatedAt: now,
        messages: [],
        usage: {
          last: { promptTokens: 0, completionTokens: 0 },
          total: { promptTokens: 0, completionTokens: 0 },
        },
      };

    session.projectDir = workdir;
    session.provider = this.config.provider.name;
    session.model = this.config.model;

    const systemPrompt =
      buildSystemPrompt({
        interface: "telegram",
        enabledToolNames: this.config.registry.list().map((t) => t.name),
      }) + telegramSystemContext(message);

    const agent = new Agent({
      provider: this.config.provider,
      registry: this.config.registry,
      model: this.config.model,
      projectDir: workdir,
      systemPrompt,
      contextOptimize: this.config.contextOptimize,
      tasksEnabled: false,
      autoContinue: this.config.autoContinue,
      maxIterations: this.config.maxIterations,
      requestDelayMs: this.config.requestDelayMs,
      botScript: this.createBotScriptHost(),
    });
    agent.loadHistory(withSystemPrompt(session.messages, systemPrompt));

    const runtime: RuntimeSession = { agent, session, busy: false };
    this.sessions.set(id, runtime);
    return runtime;
  }

  private async resetSession(message: TelegramMessage): Promise<void> {
    await this.clearSessionFiles(message);
    await this.api.sendMessage({
      chat_id: message.chat.id,
      text: "Session Telegram ini sudah direset.",
      message_thread_id: message.message_thread_id,
    });
  }

  private async clearSessionFiles(message: TelegramMessage): Promise<void> {
    const id = sessionIdFor(message);
    this.sessions.delete(id);
    await deleteSession(id);
    await rm(join(this.config.workdirRoot, id), {
      recursive: true,
      force: true,
    });
  }

  private async sendStartMessage(message: TelegramMessage): Promise<void> {
    await this.api.sendMessage({
      chat_id: message.chat.id,
      text:
        "Siberflow Telegram bot aktif.\n\n" +
        "Kirim pesan untuk mulai chat. Session dan workdir dibuat terpisah per chat/thread.\n" +
        "Gunakan /reset untuk menghapus session chat/thread ini.",
      message_thread_id: message.message_thread_id,
    });
  }

  private async runTurn(
    runtime: RuntimeSession,
    message: TelegramMessage,
    input: string,
  ): Promise<void> {
    runtime.pendingUsage = undefined;
    let content = "";
    let lastDraftAt = 0;
    let draftSent = false;
    const canDraft = message.chat.type === "private";
    const draftId = canDraft ? newTelegramRandomId() : 0;
    const shownToolStatuses = new Set<string>();
    let activeToolStatus = "";
    let toolHeartbeat: ReturnType<typeof setInterval> | null = null;
    const groupStatus: { promise?: Promise<number | undefined> } = {};

    const sendDraft = (text: string): void => {
      if (!canDraft) return;
      lastDraftAt = Date.now();
      draftSent = true;
      void this.api
        .sendMessageDraft(message.chat.id, draftId, text)
        .catch((err) =>
          console.error(`Telegram draft error: ${(err as Error).message}`),
        );
    };

    const clearToolHeartbeat = (): void => {
      if (toolHeartbeat) {
        clearInterval(toolHeartbeat);
        toolHeartbeat = null;
      }
      activeToolStatus = "";
    };

    const showToolDraft = (status: string): void => {
      activeToolStatus = status;
      sendDraft(`${content}${content ? "\n\n" : ""}${status}`);
      if (!toolHeartbeat) {
        toolHeartbeat = setInterval(() => {
          if (!activeToolStatus) return;
          sendDraft(
            `${content}${content ? "\n\n" : ""}${activeToolStatus}`,
          );
        }, 10_000);
      }
    };

    if (!canDraft) {
      await this.api.sendChatAction(message.chat.id, "typing", message.message_thread_id);
    }

    try {
      const final = await this.activeTurn.run(
        { message, workdir: runtime.session.projectDir },
        () =>
          runtime.agent.send(input, {
            onContent: (delta) => {
              content += delta;
              if (!canDraft) return;
              const now = Date.now();
              if (now - lastDraftAt < DRAFT_MIN_INTERVAL_MS) return;
              sendDraft(
                activeToolStatus
                  ? `${content}${content ? "\n\n" : ""}${activeToolStatus}`
                  : content,
              );
            },
            onAssistantEnd: (_msg, meta) => {
              if (meta.usage) runtime.pendingUsage = meta.usage;
            },
            onToolCallStart: (_index, name) => {
              const status = toolStatusText(name);
              if (!canDraft) {
                void this.api.sendChatAction(message.chat.id, "typing", message.message_thread_id);
                if (!shownToolStatuses.has(name)) {
                  shownToolStatuses.add(name);
                  groupStatus.promise = this.api
                    .sendMessage({
                      chat_id: message.chat.id,
                      text: status,
                      message_thread_id: message.message_thread_id,
                    })
                    .then((sent) => sent.message_id)
                    .catch((err) => {
                      console.error(`Telegram status error: ${(err as Error).message}`);
                      return undefined;
                    });
                }
                return;
              }
              showToolDraft(status);
            },
            onToolResult: () => {
              clearToolHeartbeat();
            },
          }),
      );

      clearToolHeartbeat();
      content = final || content || "(empty response)";
      if (canDraft && !draftSent) {
        await this.api.sendMessageDraft(message.chat.id, draftId, content);
      }
      const replaceMessageId = groupStatus.promise
        ? await groupStatus.promise
        : undefined;
      await this.sendFinal(message, content, replaceMessageId);
      await this.persist(runtime);
    } catch (err) {
      clearToolHeartbeat();
      const text = `Error: ${(err as Error).message}`;
      await this.api.sendMessage({
        chat_id: message.chat.id,
        text,
        message_thread_id: message.message_thread_id,
      });
    }
  }

  private async sendFinal(
    message: TelegramMessage,
    text: string,
    replaceMessageId?: number,
  ): Promise<void> {
    const chunks = chunkText(text, FINAL_MAX_CHARS);
    let start = 0;
    if (replaceMessageId && chunks[0]) {
      try {
        await this.api.editRichMessage({
          chat_id: message.chat.id,
          message_id: replaceMessageId,
          text: chunks[0],
        });
        start = 1;
      } catch (err) {
        console.error(`Telegram edit status error: ${(err as Error).message}`);
      }
    }
    for (const chunk of chunks.slice(start)) {
      await this.api.sendRichMessage({
        chat_id: message.chat.id,
        text: chunk,
        message_thread_id: message.message_thread_id,
      });
    }
  }

  private async persist(runtime: RuntimeSession): Promise<void> {
    const usage = runtime.pendingUsage;
    if (usage) {
      runtime.session.usage.last = usage;
      runtime.session.usage.total = {
        promptTokens:
          runtime.session.usage.total.promptTokens + usage.promptTokens,
        completionTokens:
          runtime.session.usage.total.completionTokens + usage.completionTokens,
      };
    }
    runtime.session.messages = [...runtime.agent.history()];
    runtime.session.updatedAt = new Date().toISOString();
    await saveSession(runtime.session);
    if (this.config.contextOptimize.enabled) {
      const { messages: optimized } = optimizeContext(
        runtime.session.messages,
        this.config.contextOptimize,
      );
      if ((this.config.contextOptimize.mode ?? "recent") === "summary") {
        await saveOptimizedMiddleView(runtime.session, optimized);
      } else {
        await saveOptimizedView(runtime.session, optimized);
      }
    }
  }

  private createBotScriptHost() {
    const getActiveBotScriptState = (): { message: TelegramMessage; workdir: string } => {
      const state = this.activeTurn.getStore();
      if (!state?.message || !state.workdir) {
        throw new Error("bot_script is only available during an active Telegram turn.");
      }
      return { message: state.message, workdir: state.workdir };
    };

    return {
      get chat() {
        const state = getActiveBotScriptState();
        const message = state.message;
        return {
          id: message.chat.id,
          type: message.chat.type,
          title: message.chat.title,
          username: message.chat.username,
          messageThreadId: message.message_thread_id,
          currentMessageId: message.message_id,
        };
      },
      sendMessage: async (text: string) => {
        const state = getActiveBotScriptState();
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("sendMessage text must be a non-empty string.");
        }
        const sent = await this.api.sendMessage({
          chat_id: state.message.chat.id,
          text,
          message_thread_id: state.message.message_thread_id,
        });
        return { message_id: sent.message_id };
      },
      sendPhoto: async (path: string, caption?: string) => {
        const state = getActiveBotScriptState();
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendPhoto({
          chat_id: state.message.chat.id,
          path: file,
          caption,
          message_thread_id: state.message.message_thread_id,
        });
        return { message_id: sent.message_id };
      },
      sendDocument: async (path: string, caption?: string) => {
        const state = getActiveBotScriptState();
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendDocument({
          chat_id: state.message.chat.id,
          path: file,
          caption,
          message_thread_id: state.message.message_thread_id,
        });
        return { message_id: sent.message_id };
      },
    };
  }
}

async function resolveTelegramWorkdirPath(
  workdir: string,
  path: string,
): Promise<string> {
  if (typeof path !== "string" || !path.trim()) {
    throw new Error("Path must be a non-empty string.");
  }
  const root = await realpath(workdir);
  const target = await realpath(isAbsolute(path) ? path : resolve(root, path));
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }
  throw new Error("Path escapes the Telegram session workdir.");
}

class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
  ) {}

  async getMe(): Promise<TelegramUser> {
    return this.call("getMe", {});
  }

  async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(args: {
    chat_id: number;
    text: string;
    message_thread_id?: number;
  }): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      ...withThread(args.message_thread_id),
      chat_id: args.chat_id,
      text: args.text,
    });
  }

  async sendChatAction(
    chatId: number,
    action: "typing",
    threadId?: number,
  ): Promise<unknown> {
    return this.call("sendChatAction", {
      ...withThread(threadId),
      chat_id: chatId,
      action,
    });
  }

  async sendRichMessage(args: {
    chat_id: number;
    text: string;
    message_thread_id?: number;
  }): Promise<unknown> {
    return this.call("sendRichMessage", {
      ...withThread(args.message_thread_id),
      chat_id: args.chat_id,
      rich_message: { html: toRichHtml(args.text) },
    });
  }

  async sendPhoto(args: {
    chat_id: number;
    path: string;
    caption?: string;
    message_thread_id?: number;
  }): Promise<TelegramMessage> {
    const data = await readFile(args.path);
    const form = new FormData();
    form.set("chat_id", String(args.chat_id));
    if (args.message_thread_id) {
      form.set("message_thread_id", String(args.message_thread_id));
    }
    if (args.caption) form.set("caption", args.caption);
    form.set("photo", new Blob([new Uint8Array(data)]), basename(args.path));
    return this.callMultipart("sendPhoto", form);
  }

  async sendDocument(args: {
    chat_id: number;
    path: string;
    caption?: string;
    message_thread_id?: number;
  }): Promise<TelegramMessage> {
    const data = await readFile(args.path);
    const form = new FormData();
    form.set("chat_id", String(args.chat_id));
    if (args.message_thread_id) {
      form.set("message_thread_id", String(args.message_thread_id));
    }
    if (args.caption) form.set("caption", args.caption);
    form.set("document", new Blob([new Uint8Array(data)]), basename(args.path));
    return this.callMultipart("sendDocument", form);
  }

  async editRichMessage(args: {
    chat_id: number;
    message_id: number;
    text: string;
  }): Promise<unknown> {
    return this.call("editMessageText", {
      chat_id: args.chat_id,
      message_id: args.message_id,
      rich_message: { html: toRichHtml(args.text) },
    });
  }

  async sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
  ): Promise<unknown> {
    return this.call("sendMessageDraft", {
      chat_id: chatId,
      draft_id: draftId,
      text,
    });
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.call<TelegramFile>("getFile", { file_id: fileId });
    if (!file.file_path) {
      throw new Error("Telegram getFile returned no file_path.");
    }
    const url = `${this.baseUrl.replace(/\/$/, "")}/file/bot${this.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Telegram file download failed with HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TelegramResponse<T>;
    if (!res.ok || !json.ok || json.result === undefined) {
      throw new Error(json.description ?? `${method} failed with HTTP ${res.status}`);
    }
    return json.result;
  }

  private async callMultipart<T>(method: string, body: FormData): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/bot${this.token}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      body,
    });
    const json = (await res.json()) as TelegramResponse<T>;
    if (!res.ok || !json.ok || json.result === undefined) {
      throw new Error(json.description ?? `${method} failed with HTTP ${res.status}`);
    }
    return json.result;
  }
}

function sessionIdFor(message: TelegramMessage): string {
  const thread = message.message_thread_id
    ? `thread-${message.message_thread_id}`
    : "main";
  return `telegram-${message.chat.type}-${message.chat.id}-${thread}`.replace(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
}

function sessionNameFor(chat: TelegramChat): string {
  if (chat.type === "private") {
    const fullName = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
    return chat.username ? `@${chat.username}` : fullName || `user ${chat.id}`;
  }
  return chat.title ?? `${chat.type} ${chat.id}`;
}

function telegramSystemContext(message: TelegramMessage): string {
  const chat = message.chat;
  const lines = [
    "",
    "",
    "# Telegram runtime context",
    `Chat type: ${chat.type}`,
    `Chat ID: ${chat.id}`,
  ];
  if (chat.title) lines.push(`Chat title: ${chat.title}`);
  if (chat.username) lines.push(`Chat username: @${chat.username}`);
  if (message.message_thread_id) {
    lines.push(`Message thread ID: ${message.message_thread_id}`);
  }
  if (message.from) {
    lines.push(
      `Current user ID: ${message.from.id}`,
      `Current user name: ${message.from.username ? `@${message.from.username}` : message.from.first_name}`,
    );
  }
  lines.push(
    "When using bot_script, operate only in this current Telegram chat/thread and current session workdir.",
    "Do not invent Telegram chat IDs; use bot.chat for the active chat metadata.",
  );
  return lines.join("\n");
}

function withSystemPrompt(
  messages: Session["messages"],
  systemPrompt: string,
): Session["messages"] {
  if (messages.length === 0) return [];
  const next = [...messages];
  if (next[0]?.role === "system") {
    next[0] = { ...next[0], content: systemPrompt };
    return next;
  }
  return [{ role: "system", content: systemPrompt }, ...next];
}

function toolStatusText(name: string): string {
  switch (name) {
    case "run_browser":
      return "⏳ Mencari info...";
    case "bot_script":
      return "⏳ Menjalankan aksi Telegram...";
    default:
      return "⏳ Memproses...";
  }
}

function normalizeInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return stripCommand(trimmed) ?? trimmed;
}

interface TelegramImageContext {
  replyImagePath?: string;
  directImagePath?: string;
}

function withTelegramImageContext(
  message: TelegramMessage,
  input: string,
  images: TelegramImageContext,
): string {
  const trimmedInput = input.trim();
  if (!trimmedInput) return "";

  const replied = message.reply_to_message;
  const repliedContext = replied
    ? describeRepliedMessage(replied, images.replyImagePath)
    : describeReplyFallback(message);
  const directContext = describeDirectMessageImage(message, images.directImagePath);
  if (!repliedContext && !directContext) return trimmedInput;

  const blocks: string[] = [];
  if (repliedContext) {
    const sender = replied?.from
      ? replied.from.username
        ? `@${replied.from.username}`
        : replied.from.first_name
      : "unknown";
    blocks.push(
      [
        "# Telegram replied message context",
        `Sender: ${sender}`,
        ...(replied ? [`Message ID: ${replied.message_id}`] : []),
        "",
        repliedContext,
      ].join("\n"),
    );
  }
  if (directContext) {
    blocks.push(["# Telegram current message attachment context", directContext].join("\n"));
  }
  blocks.push(["# User message", trimmedInput].join("\n"));
  return blocks.join("\n\n");
}

function describeDirectMessageImage(
  message: TelegramMessage,
  downloadedImagePath?: string,
): string {
  if (!message.photo?.length && !message.document?.mime_type?.startsWith("image/")) {
    return "";
  }
  return describeRepliedMessage(message, downloadedImagePath)
    .replaceAll("Replied message contains", "Current message contains");
}

function describeReplyFallback(message: TelegramMessage): string {
  const parts: string[] = [];
  const quote = message.quote?.text.trim();
  if (quote) {
    parts.push(
      `[Quoted text from the replied Telegram message]\n${quote}`,
    );
  }

  const external = message.external_reply;
  if (external) {
    parts.push(describeExternalReply(external));
  }

  return parts.filter((p) => p.trim()).join("\n\n");
}

function describeExternalReply(reply: TelegramExternalReplyInfo): string {
  const pseudo: TelegramMessage = {
    message_id: reply.message_id ?? 0,
    chat: reply.chat ?? { id: 0, type: "private" },
    photo: reply.photo,
    document: reply.document,
    sticker: reply.sticker,
    animation: reply.animation,
    video: reply.video,
    voice: reply.voice,
    audio: reply.audio,
  };
  return describeRepliedMessage(pseudo);
}

function describeRepliedMessage(
  message: TelegramMessage,
  downloadedImagePath?: string,
): string {
  const parts: string[] = [];
  const text = (message.text ?? message.caption ?? "").trim();
  if (text) parts.push(text);

  if (downloadedImagePath) {
    parts.push(
      `[Local image path for analyze_image: ${downloadedImagePath}]`,
    );
  }

  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1]!;
    parts.push(
      `[Replied message contains a photo: ${largest.width}x${largest.height}${formatBytes(largest.file_size)}. Use analyze_image with the local image path when visual understanding is needed.]`,
    );
  }
  if (message.document) {
    parts.push(
      `[Replied message contains a document: ${message.document.file_name ?? "unnamed"}${message.document.mime_type ? `, ${message.document.mime_type}` : ""}${formatBytes(message.document.file_size)}.]`,
    );
  }
  if (message.sticker) {
    parts.push(
      `[Replied message contains a sticker${message.sticker.emoji ? `: ${message.sticker.emoji}` : ""}.]`,
    );
  }
  if (message.animation) {
    parts.push(
      `[Replied message contains an animation/GIF${message.animation.file_name ? `: ${message.animation.file_name}` : ""}${formatBytes(message.animation.file_size)}.]`,
    );
  }
  if (message.video) {
    parts.push(
      `[Replied message contains a video${message.video.file_name ? `: ${message.video.file_name}` : ""}${formatBytes(message.video.file_size)}.]`,
    );
  }
  if (message.voice) {
    parts.push(
      `[Replied message contains a voice message${message.voice.duration ? `, duration ${message.voice.duration}s` : ""}${formatBytes(message.voice.file_size)}.]`,
    );
  }
  if (message.audio) {
    parts.push(
      `[Replied message contains an audio file${message.audio.title ? `: ${message.audio.title}` : ""}${formatBytes(message.audio.file_size)}.]`,
    );
  }

  return parts.length > 0
    ? parts.join("\n\n")
    : "[Telegram included a replied message reference, but no text/caption or supported attachment metadata was present in the bot update.]";
}

function formatBytes(bytes: number | undefined): string {
  return typeof bytes === "number" ? `, ${bytes} bytes` : "";
}

function sanitizeLocalFileName(name: string, fallbackId: number): string {
  const ext = extname(name).toLowerCase() || ".jpg";
  const stem = name
    .slice(0, name.length - ext.length)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${stem || `telegram-image-${fallbackId}`}${ext}`;
}

function stripCommand(text: string): string | null {
  const match = text.trim().match(/^\/siberflow(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return (match[1] ?? "").trim();
}

function stripBotMention(text: string, botUsername: string): string | null {
  const username = botUsername.trim();
  if (!username) return null;
  const pattern = new RegExp(`@${escapeRegExp(username)}\\b`, "i");
  if (!pattern.test(text)) return null;
  return text.replace(pattern, "").trim();
}

function isCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, "i").test(text.trim());
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRichHtml(text: string): string {
  const source = text.trim();
  if (!source) return "<p>(empty response)</p>";
  try {
    const html = marked.parse(source, {
      async: false,
      breaks: true,
      gfm: true,
    });
    return typeof html === "string" && html.trim()
      ? html.trim()
      : fallbackPlainHtml(source);
  } catch {
    return fallbackPlainHtml(source);
  }
}

function fallbackPlainHtml(text: string): string {
  const safe = escapeHtml(text).trim();
  if (!safe) return "<p>(empty response)</p>";
  return safe
    .split(/\n{2,}/)
    .map((part) => `<p>${part}</p>`)
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.length > 0 ? chunks : ["(empty response)"];
}

function withThread(messageThreadId: number | undefined): {
  message_thread_id?: number;
} {
  return messageThreadId ? { message_thread_id: messageThreadId } : {};
}

function newTelegramRandomId(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
