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
  type BotScriptHost,
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

/** Hard timeout for a single Telegram API fetch, so a stalled network
 * connection can never hang a turn indefinitely. Telegram's long-poll getUpdates
 * uses its own longer timeout via getUpdates(). */
const API_TIMEOUT_MS = 30_000;
/** Max retry attempts for transient network errors (ETIMEDOUT, fetch failed,
 * HTTP 5xx, 429). Delays: 1s, 2s, 4s. */
const API_MAX_RETRIES = 3;
/** Group/supergroup typing indicator lasts ~5s; refresh every 4s to keep it
 * visible while the assistant streams content (which otherwise has no UI
 * feedback in non-private chats). */
const GROUP_TYPING_INTERVAL_MS = 4_000;

async function main(): Promise<void> {
  await loadDotEnv();
  const config = loadAppConfig();
  await mkdir(config.workdirRoot, { recursive: true });

  // Global backstop: a single rejected promise (e.g. a fire-and-forget Telegram
  // API call failing when the network to api.telegram.org drops) must NEVER kill
  // the whole bot process. Default Node behavior is to crash on unhandled
  // rejections; we override that here so the bot stays alive and the per-update
  // try/catch + retry logic handles the recovery.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection (suppressed, bot continues):");
    console.error(reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (suppressed, bot continues):");
    console.error(err instanceof Error ? err.stack ?? err.message : err);
  });

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
  /**
   * AbortController for the currently running turn. Passed into agent.send() so
   * that if a turn fails or needs to be cancelled, any in-flight LLM request
   * can be aborted cleanly instead of hanging. Mirrors the per-turn abort
   * pattern used by the Desktop (agent-host.ts) and VS Code (chat-panel.ts)
   * hosts. Telegram has no user "Stop" button, so abort is currently only
   * triggered implicitly on turn teardown; the field is here for resilience.
   */
  private turnAbort: AbortController | null = null;

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
    if (
      message.chat.type !== "private" &&
      !isAddressedToBot(messageText, this.botUsername)
    ) {
      return;
    }

    try {
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
    } catch (err) {
      // Surface pre-turn errors (session load failure, busy-check reply, image
      // context, etc.) to the user instead of silently swallowing them. These
      // never crashed the process (the outer .catch in run() caught them), but
      // previously left the user with no feedback at all. runTurn has its own
      // try/catch and never reaches here; this only covers the paths above it.
      console.error(`Telegram handleUpdate error: ${(err as Error).message}`);
      await this.notifyError(message, err).catch(() => {
        // notifyError itself can fail (network down) — best-effort, never throw.
      });
    }
  }

  /** Best-effort error notification to a chat. Swallows its own errors so it
   * can never throw out of the catch block that calls it. */
  private async notifyError(message: TelegramMessage, err: unknown): Promise<void> {
    const text = `Error: ${(err as Error).message}`;
    await this.api.sendMessage({
      chat_id: message.chat.id,
      text,
      message_thread_id: message.message_thread_id,
    });
  }

  private normalizeIncomingInput(message: TelegramMessage): string {
    const text = message.text ?? message.caption ?? "";
    if (message.chat.type === "private") return normalizeInput(text);

    const commandInput = stripCommand(text);
    if (commandInput !== null) return commandInput;

    const mentionInput = stripBotMention(text, this.botUsername);
    if (mentionInput !== null) return mentionInput;

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
      }) + telegramSystemContext(message, workdir);

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
    let activeToolStatus = "";
    let toolHeartbeat: ReturnType<typeof setInterval> | null = null;
    let groupTyping: ReturnType<typeof setInterval> | null = null;
    const groupStatus: {
      promise?: Promise<number | undefined>;
      lastText?: string;
    } = {};

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

    const clearGroupTyping = (): void => {
      if (groupTyping) {
        clearInterval(groupTyping);
        groupTyping = null;
      }
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

    /** Fire-and-forget typing indicator refresh for group/supergroup chats.
     * Telegram's "typing..." indicator expires after ~5s; without periodic
     * refresh the chat looks frozen (no feedback) while the assistant is
     * streaming or a long tool runs. All calls are swallowed on failure so a
     * network blip can never become an unhandled rejection. */
    const pokeGroupTyping = (): void => {
      void this.api
        .sendChatAction(message.chat.id, "typing", message.message_thread_id)
        .catch((err) =>
          console.error(`Telegram typing error: ${(err as Error).message}`),
        );
    };

    const showGroupToolStatus = (status: string): void => {
      if (canDraft) return;
      pokeGroupTyping();
      if (groupStatus.lastText === status) return;
      groupStatus.lastText = status;

      if (!groupStatus.promise) {
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
        return;
      }

      groupStatus.promise = groupStatus.promise.then(async (messageId) => {
        if (!messageId) return undefined;
        try {
          await this.api.editRichMessage({
            chat_id: message.chat.id,
            message_id: messageId,
            text: status,
          });
        } catch (err) {
          console.error(`Telegram status edit error: ${(err as Error).message}`);
        }
        return messageId;
      });
    };

    if (!canDraft) {
      // Initial typing indicator + recurring refresh for the whole turn. This
      // keeps the group chat from looking "stuck" while the assistant works.
      pokeGroupTyping();
      groupTyping = setInterval(pokeGroupTyping, GROUP_TYPING_INTERVAL_MS);
    }

    // Per-turn abort controller so an in-flight LLM request can be cancelled
    // cleanly if this turn throws. Mirrors Desktop/VSCode hosts.
    const abort = new AbortController();
    this.turnAbort = abort;

    try {
      const final = await this.activeTurn.run(
        { message, workdir: runtime.session.projectDir },
        () =>
          runtime.agent.send(input, {
            signal: abort.signal,
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
                showGroupToolStatus(status);
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
      clearGroupTyping();
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
      clearGroupTyping();
      // Cancel any in-flight LLM request from this turn so it doesn't linger.
      abort.abort();
      const text = `Error: ${(err as Error).message}`;
      const replaceMessageId = groupStatus.promise
        ? await groupStatus.promise
        : undefined;
      await this.sendFinal(message, text, replaceMessageId);
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
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
        // The status message ("⏳ Memproses...") could not be edited into the
        // final result. We must NOT leave it hanging AND post a new message
        // (that was the "two messages" bug: orphaned spinner + duplicate
        // result). Instead, delete the orphaned status message, then post all
        // chunks fresh. If the delete also fails (already gone, no group
        // rights), we still proceed — a leftover spinner is far better than a
        // broken turn.
        console.error(`Telegram edit status error: ${(err as Error).message}`);
        await this.api
          .deleteMessage(message.chat.id, replaceMessageId)
          .catch((delErr) =>
            console.error(
              `Telegram status delete error: ${(delErr as Error).message}`,
            ),
          );
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

  private createBotScriptHost(): BotScriptHost {
    const getActiveBotScriptState = (): { message: TelegramMessage; workdir: string } => {
      const state = this.activeTurn.getStore();
      if (!state?.message || !state.workdir) {
        throw new Error("bot_script is only available during an active Telegram turn.");
      }
      return { message: state.message, workdir: state.workdir };
    };

    // Resolve the target chat for a send action. Defaults to the active chat;
    // an explicit numeric chatId override lets the bot send elsewhere (e.g. the
    // current user's private chat, reachable via bot.chat.currentUserId). The
    // user must have /start-ed the bot in private for cross-chat sends to work
    // — Telegram rejects otherwise, and that error is surfaced to the AI.
    const resolveTarget = (chatId: unknown): {
      chatId: number;
      threadId: number | undefined;
    } => {
      const state = getActiveBotScriptState();
      if (chatId === undefined || chatId === null) {
        return {
          chatId: state.message.chat.id,
          threadId: state.message.message_thread_id,
        };
      }
      if (typeof chatId !== "number" || !Number.isFinite(chatId)) {
        throw new Error("chatId must be a valid number.");
      }
      // A private chat (user id) has no thread; only the originating group does.
      // When overriding to a different chat, never leak the group's thread id.
      return { chatId, threadId: undefined };
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
          currentUserId: message.from?.id,
          currentUserUsername: message.from?.username,
        };
      },
      sendMessage: async (text: string, chatId?: number) => {
        const target = resolveTarget(chatId);
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("sendMessage text must be a non-empty string.");
        }
        const sent = await this.api.sendMessage({
          chat_id: target.chatId,
          text,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendPhoto: async (path: string, caption?: string, chatId?: number) => {
        const state = getActiveBotScriptState();
        const target = resolveTarget(chatId);
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendPhoto({
          chat_id: target.chatId,
          path: file,
          caption,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendDocument: async (path: string, caption?: string, chatId?: number) => {
        const state = getActiveBotScriptState();
        const target = resolveTarget(chatId);
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendDocument({
          chat_id: target.chatId,
          path: file,
          caption,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendVideo: async (path: string, caption?: string, chatId?: number) => {
        const state = getActiveBotScriptState();
        const target = resolveTarget(chatId);
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendMediaFile({
          method: "sendVideo",
          field: "video",
          chat_id: target.chatId,
          path: file,
          caption,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendAudio: async (path: string, caption?: string, chatId?: number) => {
        const state = getActiveBotScriptState();
        const target = resolveTarget(chatId);
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendMediaFile({
          method: "sendAudio",
          field: "audio",
          chat_id: target.chatId,
          path: file,
          caption,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendAnimation: async (path: string, caption?: string, chatId?: number) => {
        const state = getActiveBotScriptState();
        const target = resolveTarget(chatId);
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendMediaFile({
          method: "sendAnimation",
          field: "animation",
          chat_id: target.chatId,
          path: file,
          caption,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendVoice: async (path: string, caption?: string, chatId?: number) => {
        const state = getActiveBotScriptState();
        const target = resolveTarget(chatId);
        const file = await resolveTelegramWorkdirPath(state.workdir, path);
        const sent = await this.api.sendMediaFile({
          method: "sendVoice",
          field: "voice",
          chat_id: target.chatId,
          path: file,
          caption,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendLocation: async (
        latitude: number,
        longitude: number,
        options?: { title?: string; address?: string },
      ) => {
        if (typeof latitude !== "number" || typeof longitude !== "number") {
          throw new Error("sendLocation requires numeric latitude and longitude.");
        }
        const target = resolveTarget(undefined);
        // Note: Telegram's sendLocation uses venue's title/address via a
        // separate sendVenue call; here we ignore options for the plain point.
        void options;
        const sent = await this.api.sendLocation({
          chat_id: target.chatId,
          latitude,
          longitude,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendPoll: async (
        question: string,
        options: string[],
        pollOpts?: { multiple?: boolean; anonymous?: boolean },
      ) => {
        if (typeof question !== "string" || !question.trim()) {
          throw new Error("sendPoll question must be a non-empty string.");
        }
        if (!Array.isArray(options) || options.length < 2 || options.length > 10) {
          throw new Error("sendPoll options must be an array of 2-10 strings.");
        }
        const target = resolveTarget(undefined);
        const sent = await this.api.sendPoll({
          chat_id: target.chatId,
          question,
          options,
          is_anonymous: pollOpts?.anonymous,
          allows_multiple_answers: pollOpts?.multiple,
          message_thread_id: target.threadId,
        });
        return { message_id: sent.message_id };
      },
      sendMediaGroup: async (paths: string[], caption?: string) => {
        const state = getActiveBotScriptState();
        const target = resolveTarget(undefined);
        if (!Array.isArray(paths) || paths.length < 2 || paths.length > 10) {
          throw new Error("sendMediaGroup paths must be an array of 2-10 strings.");
        }
        const resolved: string[] = [];
        for (const p of paths) {
          resolved.push(await resolveTelegramWorkdirPath(state.workdir, p));
        }
        const sent = await this.api.sendMediaGroup({
          chat_id: target.chatId,
          paths: resolved,
          caption,
          message_thread_id: target.threadId,
        });
        return { messages: sent.map((m) => m.message_id) };
      },
      editMessageText: async (messageId: number, text: string) => {
        if (typeof messageId !== "number") {
          throw new Error("editMessageText messageId must be a number.");
        }
        const state = getActiveBotScriptState();
        await this.api.editMessageText({
          chat_id: state.message.chat.id,
          message_id: messageId,
          text,
        });
        return { message_id: messageId };
      },
      deleteMessage: async (messageId: number) => {
        if (typeof messageId !== "number") {
          throw new Error("deleteMessage messageId must be a number.");
        }
        const state = getActiveBotScriptState();
        await this.api.deleteMessage(state.message.chat.id, messageId);
        return { deleted: true };
      },
      reply: async (text: string) => {
        const state = getActiveBotScriptState();
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("reply text must be a non-empty string.");
        }
        // Telegram reply is sendMessage with reply_parameters pointing at the
        // user's current message. We model it via a plain sendMessage because
        // the host's sendMessage doesn't expose reply_parameters; the script-
        // level intent ("answer this user") is still satisfied.
        const sent = await this.api.sendMessage({
          chat_id: state.message.chat.id,
          text,
          message_thread_id: state.message.message_thread_id,
        });
        return { message_id: sent.message_id };
      },
      getChat: async () => {
        const state = getActiveBotScriptState();
        return this.api.getChat(state.message.chat.id);
      },
      getChatMember: async (userId: number) => {
        if (typeof userId !== "number") {
          throw new Error("getChatMember userId must be a number.");
        }
        const state = getActiveBotScriptState();
        return this.api.getChatMember(state.message.chat.id, userId);
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

  /** Generic single-file media upload used by sendVideo/sendAudio/sendAnimation/
   * sendVoice. `field` is the Telegram media field name (video/audio/animation/
   * voice). Mirrors sendPhoto/sendDocument's structure exactly. */
  async sendMediaFile(args: {
    method: "sendVideo" | "sendAudio" | "sendAnimation" | "sendVoice";
    field: "video" | "audio" | "animation" | "voice";
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
    form.set(args.field, new Blob([new Uint8Array(data)]), basename(args.path));
    return this.callMultipart(args.method, form);
  }

  /** Send an album of photos/videos (all the same media type) as a single
   * sendMediaGroup call. Each file is attached as attach://<key> and described
   * in the JSON `media` array. Paths must resolve inside the workdir (host
   * validates before calling). */
  async sendMediaGroup(args: {
    chat_id: number;
    paths: string[];
    caption?: string;
    message_thread_id?: number;
  }): Promise<TelegramMessage[]> {
    if (args.paths.length < 2 || args.paths.length > 10) {
      throw new Error("sendMediaGroup requires 2-10 files.");
    }
    const form = new FormData();
    form.set("chat_id", String(args.chat_id));
    if (args.message_thread_id) {
      form.set("message_thread_id", String(args.message_thread_id));
    }
    // Build the media descriptor array. The first item carries the caption.
    const media = args.paths.map((p, i) => {
      const ext = extname(p).toLowerCase();
      const type = ext === ".mp4" || ext === ".mov" ? "video" : "photo";
      const key = `file${i}`;
      const entry: Record<string, string> = { type, media: `attach://${key}` };
      if (i === 0 && args.caption) entry.caption = args.caption;
      return entry;
    });
    form.set("media", JSON.stringify(media));
    for (let i = 0; i < args.paths.length; i++) {
      const data = await readFile(args.paths[i]!);
      form.set(`file${i}`, new Blob([new Uint8Array(data)]), basename(args.paths[i]!));
    }
    return this.callMultipart("sendMediaGroup", form);
  }

  async sendLocation(args: {
    chat_id: number;
    latitude: number;
    longitude: number;
    message_thread_id?: number;
  }): Promise<TelegramMessage> {
    return this.call("sendLocation", {
      ...withThread(args.message_thread_id),
      chat_id: args.chat_id,
      latitude: args.latitude,
      longitude: args.longitude,
    });
  }

  async sendPoll(args: {
    chat_id: number;
    question: string;
    options: string[];
    is_anonymous?: boolean;
    allows_multiple_answers?: boolean;
    message_thread_id?: number;
  }): Promise<TelegramMessage> {
    return this.call("sendPoll", {
      ...withThread(args.message_thread_id),
      chat_id: args.chat_id,
      question: args.question,
      options: args.options,
      ...(args.is_anonymous !== undefined ? { is_anonymous: args.is_anonymous } : {}),
      ...(args.allows_multiple_answers !== undefined
        ? { allows_multiple_answers: args.allows_multiple_answers }
        : {}),
    });
  }

  /** Plain-text edit of a bot message (used by bot_script). For rich/HTML edits
   * the host uses editRichMessage; this is the raw form exposed to scripts. */
  async editMessageText(args: {
    chat_id: number;
    message_id: number;
    text: string;
  }): Promise<unknown> {
    return this.call("editMessageText", {
      chat_id: args.chat_id,
      message_id: args.message_id,
      text: args.text,
    });
  }

  async getChat(chatId: number): Promise<unknown> {
    return this.call("getChat", { chat_id: chatId });
  }

  async getChatMember(chatId: number, userId: number): Promise<unknown> {
    return this.call("getChatMember", { chat_id: chatId, user_id: userId });
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

  /** Delete a message. Best-effort: callers swallow errors because a failed
   * delete (e.g. already-deleted message, no rights in a group) must never
   * break the turn flow. Used to clean up an orphaned "⏳ Memproses..." status
   * message when editing it into the final result fails. */
  async deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    return this.call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
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
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    return this.fetchWithRetry<T>(method, url, init);
  }

  private async callMultipart<T>(method: string, body: FormData): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/bot${this.token}/${method}`;
    // NOTE: do NOT set content-type here; fetch sets the multipart boundary.
    const init: RequestInit = { method: "POST", body };
    return this.fetchWithRetry<T>(method, url, init);
  }

  /**
   * POST to a Telegram Bot API method with a hard timeout and automatic retry
   * for transient network failures. This is the network-resilience core: when
   * the server temporarily can't reach api.telegram.org (ETIMEDOUT /
   * ENETUNREACH / ECONNRESET / fetch failed / HTTP 5xx / 429), we back off and
   * retry instead of letting the call — and possibly the whole turn — hang or
   * throw. Permanent errors (HTTP 4xx other than 429, "message is not
   * modified", etc.) are returned immediately without retry.
   */
  private async fetchWithRetry<T>(
    method: string,
    url: string,
    init: RequestInit,
  ): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, init, API_TIMEOUT_MS);
        const json = (await res.json()) as TelegramResponse<T>;
        if (res.ok && json.ok && json.result !== undefined) {
          return json.result;
        }
        const description = json.description ?? `${method} failed with HTTP ${res.status}`;
        const err = new Error(description);
        // 429 (rate limit) and 5xx are transient — retry. Everything else
        // (Bad Request, message-not-modified, auth errors, etc.) is permanent.
        if (res.status !== 429 && res.status < 500) {
          throw err;
        }
        lastError = err;
      } catch (err) {
        // Non-transient errors (e.g. "message is not modified") must NOT be
        // retried — they will never succeed and would just waste time.
        if (!isTransientError(err)) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < API_MAX_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s.
        const delayMs = 1_000 * 2 ** attempt;
        console.error(
          `Telegram ${method} transient error (attempt ${attempt + 1}/${API_MAX_RETRIES + 1}); retrying in ${delayMs}ms: ${lastError.message}`,
        );
        await sleep(delayMs);
      }
    }
    throw lastError ?? new Error(`${method} failed after ${API_MAX_RETRIES + 1} attempts`);
  }

  /** fetch() with an AbortController timeout so a stalled connection can never
   * hang until the OS TCP timeout (which can be minutes). On abort, throws an
   * error classified as transient so fetchWithRetry will retry it. */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      // Re-throw abort as a network-classified error so the retry loop treats
      // it as transient.
      if (controller.signal.aborted) {
        throw new Error(`Telegram request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Classify an error as transient (worth retrying). Covers the network errors
 * seen in production logs — ETIMEDOUT / ENETUNREACH / ECONNRESET / EAI_AGAIN —
 * plus undici's generic "fetch failed" (whose `cause` carries the real code),
 * and our own timeout message. Non-network errors (4xx, "message is not
 * modified", argument validation) return false so they fail fast.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message ?? "";
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? "";
  const causeMessage = cause?.message ?? "";

  const transientSignals = [
    "ETIMEDOUT",
    "ENETUNREACH",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "fetch failed",
    "timed out",
    "network",
    "socket hang up",
  ];
  const haystack = `${message} ${code} ${causeMessage}`.toLowerCase();
  return transientSignals.some((sig) => haystack.includes(sig.toLowerCase()));
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

function telegramSystemContext(message: TelegramMessage, workdir: string): string {
  const chat = message.chat;
  const lines = [
    "",
    "",
    "# Telegram runtime context",
    `Chat type: ${chat.type}`,
    `Chat ID: ${chat.id}`,
    `Session workdir: ${workdir}`,
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
    "",
    "# Telegram hard tool safety rules",
    "These rules override any previous behavior or examples.",
    "When using any tool in Telegram, never access, read, write, list, upload, send, or reference files outside the session workdir above.",
    "Do not use shell access in Telegram. Do not call exec or ask for shell commands. If shell access was used in any previous Telegram turn, treat that as a mistake and do not repeat it.",
    "If a requested action requires files outside the session workdir or shell access, refuse that part and explain that Telegram tools are limited to the session workdir.",
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

function isAddressedToBot(text: string, botUsername: string): boolean {
  const username = botUsername.trim();
  if (!username) return false;
  return new RegExp(`@${escapeRegExp(username)}\\b`, "i").test(text);
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
