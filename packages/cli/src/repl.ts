import { createInterface } from "node:readline/promises";
import {
  Agent,
  deleteSession,
  findByNameOrId,
  listSessions,
  newSessionId,
  saveSession,
  SESSION_FORMAT_VERSION,
  type Session,
  type ToolRegistry,
} from "@siberflow/core";
import type { Provider } from "@siberflow/core";
import { ui } from "./ui.js";
import { MarkdownStreamer } from "./markdown.js";
import { ToolCallRenderer } from "./tool-renderer.js";

const VERSION = "0.1.0";

const SYSTEM_PROMPT = `You are siberflow, an AI assistant running in a terminal. \
You have tools for file management (read_file, write_file, edit_file, copy_file, list_dir) \
and shell execution (exec). All file operations are sandboxed to the project directory. \
Use tools when the user asks you to read, modify, or inspect their files or system. \
Keep responses concise.`;

export interface ReplOptions {
  provider: Provider;
  registry: ToolRegistry;
  model: string;
  projectDir: string;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const agent = new Agent({
    provider: opts.provider,
    registry: opts.registry,
    model: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    projectDir: opts.projectDir,
  });

  const ctx: SessionContext = {
    agent,
    projectDir: opts.projectDir,
    provider: opts.provider.name,
    model: opts.model,
    current: null,
  };

  const resumed = await tryResumeLatest(ctx);

  console.log(
    ui.banner({
      version: VERSION,
      provider: opts.provider.name,
      model: opts.model,
      projectDir: opts.projectDir,
      session: resumed
        ? { label: sessionLabel(resumed), messageCount: resumed.messages.length }
        : null,
    }),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    let input: string;
    try {
      input = (await rl.question(ui.prompt())).trim();
    } catch {
      break;
    }
    if (!input) continue;

    if (input.startsWith("/")) {
      const handled = await handleSlashCommand(input, ctx, opts.registry);
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
}

function sessionLabel(s: Session | null): string {
  if (!s) return "(unsaved)";
  return s.name ?? s.id;
}

async function tryResumeLatest(ctx: SessionContext): Promise<Session | null> {
  const summaries = await listSessions({ projectDir: ctx.projectDir });
  const latest = summaries[0];
  if (!latest) return null;
  const { loadSession } = await import("@siberflow/core");
  const full = await loadSession(latest.id);
  if (!full) return null;
  ctx.agent.loadHistory(full.messages);
  ctx.current = full;
  return full;
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
  };
}

async function persistAfterTurn(ctx: SessionContext): Promise<void> {
  const id = ctx.current?.id ?? newSessionId();
  const session = buildSessionFromAgent(ctx, id);
  await saveSession(session);
  ctx.current = session;
}

async function runTurn(input: string, ctx: SessionContext): Promise<void> {
  const renderers = new Map<number, ToolCallRenderer>();
  const md = new MarkdownStreamer();
  let prefixPrinted = false;

  const ensurePrefix = () => {
    if (!prefixPrinted) {
      process.stdout.write(ui.assistantPrefix());
      prefixPrinted = true;
    }
  };

  const flushMd = () => {
    const rest = md.finish();
    if (rest) {
      ensurePrefix();
      process.stdout.write(rest + "\n");
    }
  };

  try {
    await ctx.agent.send(input, {
      onAssistantStart: () => {
        prefixPrinted = false;
        md.reset();
        renderers.clear();
      },
      onContent: (delta) => {
        const formatted = md.feed(delta);
        if (formatted) {
          ensurePrefix();
          process.stdout.write(formatted);
        }
      },
      onAssistantEnd: () => {
        flushMd();
        for (const r of renderers.values()) r.finishArgs();
      },
      onToolCallStart: (index, name) => {
        flushMd();
        renderers.set(index, new ToolCallRenderer(name));
      },
      onToolCallArgs: (index, delta) => {
        renderers.get(index)?.feed(delta);
      },
      onToolResult: (index, _name, result) => {
        renderers.get(index)?.result(result);
      },
    });
    await persistAfterTurn(ctx);
  } catch (err) {
    flushMd();
    console.log(ui.error((err as Error).message));
  }
}

async function handleSlashCommand(
  input: string,
  ctx: SessionContext,
  registry: ToolRegistry,
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
            "/delete <name>   delete a session",
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

    default:
      console.log(ui.error(`unknown command: ${cmd} (try /help)`));
      return "ok";
  }
}
