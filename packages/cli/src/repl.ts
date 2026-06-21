import { createInterface } from "node:readline/promises";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import {
  Agent,
  buildSystemPrompt,
  clearSessions,
  deleteSession,
  findByNameOrId,
  listSessions,
  loadSession,
  newSessionId,
  optimizeContext,
  saveOptimizedView,
  saveOptimizedMiddleView,
  saveSession,
  saveSessionSync,
  SESSION_FORMAT_VERSION,
  type ContextOptimizeConfig,
  type Session,
  type ToolRegistry,
} from "@siberflow/core";
import type { Provider } from "@siberflow/core";
import { ui } from "./ui.js";
import { MarkdownStreamer } from "./markdown.js";
import { Spinner } from "./spinner.js";
import { ToolCallRenderer } from "./tool-renderer.js";

const VERSION = "0.1.0";


export interface ReplOptions {
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  projectDir: string;
  contextOptimize: ContextOptimizeConfig;
  tasksEnabled: boolean;
  autoContinue: boolean;
  maxIterations: number;
  hideTools: boolean;
  requestDelayMs: number;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const summaryMode =
    opts.contextOptimize.enabled &&
    (opts.contextOptimize.mode ?? "summary") === "summary";
  const systemPrompt = buildSystemPrompt({
    interface: "terminal",
    tasksEnabled: opts.tasksEnabled,
    summaryMode,
  });

  const agent = new Agent({
    provider: opts.provider,
    registry: opts.registry,
    model: opts.model,
    systemPrompt,
    projectDir: opts.projectDir,
    contextOptimize: opts.contextOptimize,
    tasksEnabled: opts.tasksEnabled,
    autoContinue: opts.autoContinue,
    maxIterations: opts.maxIterations,
    requestDelayMs: opts.requestDelayMs,
  });

  const ctx: SessionContext = {
    agent,
    projectDir: opts.projectDir,
    provider: opts.provider.name,
    model: opts.model,
    current: null,
    contextOptimize: opts.contextOptimize,
    tasksEnabled: opts.tasksEnabled,
    hideTools: opts.hideTools,
    optStats: { collapsedTurns: 0, bytesSaved: 0 },
  };

  console.log(
    ui.splashBanner({
      version: VERSION,
      provider: opts.provider.name,
      model: opts.model,
      projectDir: opts.projectDir,
    }),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const choice = await chooseSession(rl, ctx.projectDir);
  if (!choice) {
    rl.close();
    return;
  }
  applyChoice(ctx, choice);
  console.log();
  console.log(ui.info(`  ${ui.helpLine()}`));
  console.log();

  while (true) {
    let input: string;
    try {
      input = (await rl.question(ui.prompt())).trim();
    } catch {
      break;
    }
    if (!input) continue;

    if (input.startsWith("/")) {
      const handled = await handleSlashCommand(input, ctx, opts.registry, rl);
      if (handled === "exit") break;
      continue;
    }

    await runTurn(input, ctx);
  }

  rl.close();
}

interface SessionContext {
  agent: Agent;
  projectDir: string;
  provider: string;
  model: string;
  current: Session | null;
  contextOptimize: ContextOptimizeConfig;
  tasksEnabled: boolean;
  hideTools: boolean;
  /** Accumulated since this REPL process started (not persisted to session). */
  optStats: { collapsedTurns: number; bytesSaved: number };
}

function sessionLabel(s: Session | null): string {
  if (!s) return "(unsaved)";
  return s.name ?? s.id;
}

type SessionChoice =
  | { type: "loaded"; session: Session }
  | { type: "new"; name: string | null };

async function chooseSession(
  rl: ReadlineInterface,
  projectDir: string,
): Promise<SessionChoice | null> {
  const summaries = await listSessions({ projectDir });

  console.log();
  if (summaries.length === 0) {
    console.log(ui.info("  belum ada sesi tersimpan untuk project ini."));
    const name = await promptSessionName(rl);
    if (name === null && summaries.length === 0) {
      // null only via ctrl+c; treat as abort
      return null;
    }
    return { type: "new", name };
  }

  console.log(ui.info("  Sesi yang tersedia:"));
  const shown = summaries.slice(0, 10);
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i]!;
    const label = s.name ?? `(unnamed) ${s.id.slice(0, 19)}`;
    console.log(
      `   [${i + 1}] ${label}  ${ui.info(`${s.messageCount} msgs · ${formatRelative(s.updatedAt)}`)}`,
    );
  }
  if (summaries.length > shown.length) {
    console.log(
      ui.info(
        `   ... +${summaries.length - shown.length} sesi lain (ketik nama untuk pilih)`,
      ),
    );
  }
  console.log(`   [n] buat sesi baru`);
  console.log();

  while (true) {
    let answer: string;
    try {
      answer = (
        await rl.question(ui.info("  Pilihan (nomor/nama, n=new): "))
      ).trim();
    } catch {
      return null;
    }
    if (answer === "") continue;

    const lower = answer.toLowerCase();
    if (lower === "n" || lower === "new") {
      const name = await promptSessionName(rl);
      return { type: "new", name };
    }

    const numeric = Number.parseInt(answer, 10);
    if (
      !Number.isNaN(numeric) &&
      numeric >= 1 &&
      numeric <= shown.length &&
      String(numeric) === answer
    ) {
      const pick = shown[numeric - 1]!;
      const session = await loadSession(pick.id);
      if (session) return { type: "loaded", session };
      console.log(ui.error(`gagal load session ${pick.id}`));
      continue;
    }

    const byName = await findByNameOrId(answer, projectDir);
    if (byName) return { type: "loaded", session: byName };

    console.log(ui.error(`pilihan tidak valid: "${answer}"`));
  }
}

async function promptSessionName(
  rl: ReadlineInterface,
): Promise<string | null> {
  try {
    const answer = (
      await rl.question(
        ui.info("  Nama sesi (Enter untuk tanpa nama): "),
      )
    ).trim();
    return answer.length > 0 ? answer : null;
  } catch {
    return null;
  }
}

function applyChoice(ctx: SessionContext, choice: SessionChoice): void {
  if (choice.type === "loaded") {
    ctx.agent.loadHistory(choice.session.messages);
    if (ctx.tasksEnabled && choice.session.tasks?.length) {
      ctx.agent.loadTasks(choice.session.tasks);
    }
    ctx.current = choice.session;
    console.log(
      ui.info(
        `  resumed: ${sessionLabel(choice.session)} (${choice.session.messages.length} msgs)`,
      ),
    );
    if (ctx.tasksEnabled && choice.session.tasks?.length) {
      console.log(ui.taskList(choice.session.tasks));
    }
    return;
  }
  const id = newSessionId();
  const now = new Date().toISOString();
  ctx.current = {
    version: SESSION_FORMAT_VERSION,
    id,
    name: choice.name,
    projectDir: ctx.projectDir,
    provider: ctx.provider,
    model: ctx.model,
    createdAt: now,
    updatedAt: now,
    messages: [...ctx.agent.history()],
    usage: emptyUsage(),
  };
  console.log(ui.info(`  new session: ${sessionLabel(ctx.current)}`));
}

function formatRelative(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff) || diff < 0) return iso;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  return `${month}mo ago`;
}

function emptyUsage() {
  return {
    last: { promptTokens: 0, completionTokens: 0 },
    total: { promptTokens: 0, completionTokens: 0 },
  };
}

function buildSessionFromAgent(ctx: SessionContext, id: string): Session {
  const now = new Date().toISOString();
  const existing = ctx.current;
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    name: existing?.name ?? null,
    projectDir: ctx.projectDir,
    provider: ctx.provider,
    model: ctx.model,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: [...ctx.agent.history()],
    usage: existing?.usage ?? emptyUsage(),
    ...(ctx.tasksEnabled ? { tasks: [...ctx.agent.getTasks()] } : {}),
  };
}

async function persistAfterTurn(ctx: SessionContext): Promise<void> {
  const id = ctx.current?.id ?? newSessionId();
  const session = buildSessionFromAgent(ctx, id);
  await saveSession(session);
  ctx.current = session;

  if (ctx.contextOptimize.enabled) {
    const { messages: optimized } = optimizeContext(
      session.messages,
      ctx.contextOptimize,
    );
    if ((ctx.contextOptimize.mode ?? "drop") === "summary") {
      await saveOptimizedMiddleView(session, optimized);
    } else {
      await saveOptimizedView(session, optimized);
    }
  }
}

async function runTurn(input: string, ctx: SessionContext): Promise<void> {
  const renderers = new Map<number, ToolCallRenderer>();
  const md = new MarkdownStreamer();
  const spinner = new Spinner();

  // Track raw-stream state so each completed line can be erased and
  // re-rendered with markdown formatting.
  let currentLine = "";
  let prefixPrinted = false;
  let onFirstLine = false;
  let seenAnyContent = false;

  // Track both: latest call's usage (current context size) AND sum of all
  // calls in this turn (for the cumulative `total` billing counter).
  let latestUsage: { promptTokens: number; completionTokens: number } | undefined;
  let turnAddPrompt = 0;
  let turnAddCompletion = 0;

  const ensurePrefix = () => {
    if (!prefixPrinted) {
      process.stdout.write(ui.assistantPrefix());
      prefixPrinted = true;
      onFirstLine = true;
    }
  };

  // "ai  › " = 6 visible chars (ANSI codes don't count toward width)
  const PREFIX_VISIBLE_WIDTH = 6;

  // Clear ALL rows occupied by the line we just streamed (handling terminal
  // wrap) and re-emit it with markdown formatting.
  const flushCurrentLine = (withNewline: boolean) => {
    const hasContent = currentLine.length > 0;
    if (!hasContent && !onFirstLine) {
      if (withNewline) process.stdout.write("\n");
      return;
    }
    const termWidth = process.stdout.columns ?? 80;
    const totalWidth =
      currentLine.length + (onFirstLine ? PREFIX_VISIBLE_WIDTH : 0);
    const rowsUsed = Math.max(
      1,
      Math.floor((totalWidth - 1) / termWidth) + 1,
    );
    if (rowsUsed > 1) {
      process.stdout.write(`\x1b[${rowsUsed - 1}A`);
    }
    process.stdout.write("\r\x1b[0J");
    if (onFirstLine) {
      process.stdout.write(ui.assistantPrefix());
      onFirstLine = false;
    }
    process.stdout.write(md.renderLine(currentLine));
    if (withNewline) process.stdout.write("\n");
    currentLine = "";
  };

  try {
    await ctx.agent.send(input, {
      onAssistantStart: () => {
        currentLine = "";
        prefixPrinted = false;
        onFirstLine = false;
        seenAnyContent = false;
        md.reset();
        renderers.clear();
        spinner.start();
      },
      onContent: (delta) => {
        spinner.stop();
        for (let i = 0; i < delta.length; i++) {
          const ch = delta[i]!;
          if (ch === "\n") {
            if (!seenAnyContent) continue; // drop leading blank lines
            flushCurrentLine(true);
          } else {
            seenAnyContent = true;
            ensurePrefix();
            currentLine += ch;
            process.stdout.write(ch);
          }
        }
      },
      onAssistantEnd: (_msg, meta) => {
        spinner.stop();
        if (meta.usage) {
          latestUsage = meta.usage;
          turnAddPrompt += meta.usage.promptTokens;
          turnAddCompletion += meta.usage.completionTokens;
        }
        if (currentLine.length > 0 || onFirstLine) flushCurrentLine(true);
        for (const r of renderers.values()) r.finishArgs();
      },
      onToolCallStart: (index, name) => {
        // task_update is a silent housekeeping tool: still executed, but never
        // rendered in the transcript — its effect shows in the task list instead.
        if (name === "task_update") return;
        if (currentLine.length > 0 || onFirstLine) flushCurrentLine(true);
        if (ctx.hideTools) {
          // Hidden mode: no header/args/result — just a spinner with the tool name.
          spinner.setLabel(`${name}…`);
          spinner.start();
        } else {
          spinner.stop();
          renderers.set(index, new ToolCallRenderer(name));
        }
      },
      onToolCallArgs: (index, delta) => {
        if (!ctx.hideTools) renderers.get(index)?.feed(delta);
      },
      onToolResult: (index, _name, result) => {
        if (_name === "task_update") return;
        if (ctx.hideTools) {
          spinner.setLabel("thinking…");
        } else {
          renderers.get(index)?.result(result);
        }
      },
      onContextOptimized: (stats) => {
        ctx.optStats.collapsedTurns += 1;
        ctx.optStats.bytesSaved += stats.bytesSaved;
      },
      onTasksUpdated: (tasks) => {
        process.stdout.write(ui.taskList(tasks) + "\n");
        // Persist task progress to disk synchronously — survives Ctrl+C /
        // force-kill mid-turn so the user can resume from the exact task
        // checkpoint. We update only `tasks` + `updatedAt`; `messages` is
        // left as the last successful turn's snapshot to avoid persisting
        // a half-executed assistant message (dangling tool_calls would
        // break the next request).
        if (ctx.current) {
          ctx.current.tasks = [...tasks];
          ctx.current.updatedAt = new Date().toISOString();
          try {
            saveSessionSync(ctx.current);
          } catch {
            // best-effort
          }
        }
      },
      onMaxIterations: (limit) => {
        process.stdout.write(
          "\n" +
            ui.info(
              `reached the ${limit}-iteration limit — task may be incomplete. Type "lanjutkan" to continue (set SIBERFLOW_MAX_ITERATIONS to raise the cap).`,
            ) +
            "\n",
        );
      },
    });
    if (ctx.current && latestUsage) {
      ctx.current.usage.last = latestUsage;
      ctx.current.usage.total.promptTokens += turnAddPrompt;
      ctx.current.usage.total.completionTokens += turnAddCompletion;
    }
    await persistAfterTurn(ctx);
  } catch (err) {
    spinner.stop();
    if (currentLine.length > 0 || onFirstLine) flushCurrentLine(true);
    console.log(ui.error((err as Error).message));
  }
}

async function handleSlashCommand(
  input: string,
  ctx: SessionContext,
  registry: ToolRegistry,
  rl: ReadlineInterface,
): Promise<"exit" | "ok"> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/exit":
    case "/quit":
      return "exit";

    case "/help":
      console.log(
        ui.info(
          [
            "/help            show this help",
            "/tools           list available tools",
            "/list            list saved sessions for this project",
            "/new [name]      start a fresh session, optionally with a name",
            "/load <name|id>  switch to a saved session",
            "/name <name>     rename the current session",
            "/save            force-save the current session",
            "/usage           show token usage for the active session",
            "/delete <name>   delete a single session",
            "/clear-all       delete ALL sessions in this project (asks to confirm)",
            "/exit, /quit     leave the REPL",
          ].join("\n"),
        ),
      );
      return "ok";

    case "/tools": {
      const tools = registry.list();
      console.log(
        ui.info(tools.map((t) => `  ${t.name} — ${t.description}`).join("\n")),
      );
      return "ok";
    }

    case "/list": {
      const summaries = await listSessions({ projectDir: ctx.projectDir });
      if (summaries.length === 0) {
        console.log(ui.info("no sessions saved for this project yet"));
        return "ok";
      }
      const lines = summaries.map((s) => {
        const marker = ctx.current?.id === s.id ? "*" : " ";
        const label = s.name ?? `(unnamed) ${s.id}`;
        return `${marker} ${label}  — ${s.messageCount} msgs, updated ${s.updatedAt}`;
      });
      console.log(ui.info(lines.join("\n")));
      return "ok";
    }

    case "/new": {
      ctx.agent.reset();
      const id = newSessionId();
      const now = new Date().toISOString();
      ctx.current = {
        version: SESSION_FORMAT_VERSION,
        id,
        name: arg.length > 0 ? arg : null,
        projectDir: ctx.projectDir,
        provider: ctx.provider,
        model: ctx.model,
        createdAt: now,
        updatedAt: now,
        messages: [...ctx.agent.history()],
        usage: emptyUsage(),
      };
      console.log(ui.info(`started new session: ${sessionLabel(ctx.current)}`));
      return "ok";
    }

    case "/load": {
      if (!arg) {
        console.log(ui.error("usage: /load <name|id>"));
        return "ok";
      }
      const target = await findByNameOrId(arg, ctx.projectDir);
      if (!target) {
        console.log(ui.error(`no session found matching "${arg}" in this project`));
        return "ok";
      }
      ctx.agent.loadHistory(target.messages);
      ctx.current = target;
      console.log(
        ui.info(
          `loaded session: ${sessionLabel(target)} (${target.messages.length} msgs)`,
        ),
      );
      return "ok";
    }

    case "/name": {
      if (!arg) {
        console.log(ui.error("usage: /name <new-name>"));
        return "ok";
      }
      if (!ctx.current) {
        const id = newSessionId();
        ctx.current = buildSessionFromAgent(ctx, id);
      }
      ctx.current.name = arg;
      ctx.current.updatedAt = new Date().toISOString();
      await saveSession(ctx.current);
      console.log(ui.info(`renamed to: ${arg}`));
      return "ok";
    }

    case "/save": {
      const id = ctx.current?.id ?? newSessionId();
      const session = buildSessionFromAgent(ctx, id);
      await saveSession(session);
      ctx.current = session;
      console.log(ui.info(`saved: ${sessionLabel(session)}`));
      return "ok";
    }

    case "/usage": {
      const u = ctx.current?.usage;
      if (!u) {
        console.log(ui.info("(no active session)"));
        return "ok";
      }
      const fmt = (n: number) => n.toLocaleString("en-US");
      const last = u.last;
      const total = u.total;
      const lines = [
        `session:       ${sessionLabel(ctx.current)}`,
        `last call:     ${fmt(last.promptTokens)} prompt + ${fmt(last.completionTokens)} completion = ${fmt(last.promptTokens + last.completionTokens)} tokens (current context)`,
        `session total: ${fmt(total.promptTokens)} prompt + ${fmt(total.completionTokens)} completion = ${fmt(total.promptTokens + total.completionTokens)} tokens (billed)`,
      ];
      if (ctx.contextOptimize.enabled) {
        const kb = (ctx.optStats.bytesSaved / 1024).toFixed(1);
        lines.push(
          `optimization:  enabled — ${ctx.optStats.collapsedTurns} turn(s) collapsed, ~${kb} KB saved (this CLI run)`,
        );
      }
      console.log(ui.info(lines.join("\n")));
      return "ok";
    }

    case "/delete": {
      if (!arg) {
        console.log(ui.error("usage: /delete <name|id>"));
        return "ok";
      }
      const target = await findByNameOrId(arg, ctx.projectDir);
      if (!target) {
        console.log(ui.error(`no session found matching "${arg}"`));
        return "ok";
      }
      const wasCurrent = ctx.current?.id === target.id;
      await deleteSession(target.id);
      console.log(ui.info(`deleted: ${sessionLabel(target)}`));
      if (wasCurrent) {
        ctx.agent.reset();
        ctx.current = null;
        console.log(ui.info("(current session deleted — now in a fresh unsaved session)"));
      }
      return "ok";
    }

    case "/clear-all": {
      const summaries = await listSessions({ projectDir: ctx.projectDir });
      if (summaries.length === 0) {
        console.log(ui.info("no sessions to clear for this project"));
        return "ok";
      }
      let answer: string;
      try {
        answer = (
          await rl.question(
            ui.info(
              `Delete all ${summaries.length} session(s) for this project? Type "yes" to confirm: `,
            ),
          )
        ).trim();
      } catch {
        return "ok";
      }
      if (answer.toLowerCase() !== "yes") {
        console.log(ui.info("cancelled"));
        return "ok";
      }
      const removed = await clearSessions({ projectDir: ctx.projectDir });
      ctx.agent.reset();
      ctx.current = null;
      console.log(
        ui.info(`cleared ${removed} session(s); now in a fresh unsaved session`),
      );
      return "ok";
    }

    default:
      console.log(ui.error(`unknown command: ${cmd} (try /help)`));
      return "ok";
  }
}
