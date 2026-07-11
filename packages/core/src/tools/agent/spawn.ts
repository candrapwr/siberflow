import type { Provider } from "../../providers/base.js";
import type { Tool } from "../base.js";
import { ToolRegistry } from "../registry.js";
import { Agent } from "../../agent/agent.js";

/** Focused Agent General prompt — clean slate, efficient, concise result. */
const AGENT_GENERAL_SYSTEM_PROMPT = `You are a focused Agent General spawned by the main Siberflow agent for a single task. You have a clean context — no prior conversation. Your job: complete the assigned task using only the delegated tools, then return a concise final result.

Rules:
- Focus ONLY on the task. Do not explore beyond what's needed.
- Iterate with tools as needed, but be efficient — avoid redundant calls.
- When done, return a clear, factual summary of what you found/did.`;

/** Read-only Agent Explorer prompt — search and read (codebase + web), no modifications. */
const AGENT_EXPLORER_SYSTEM_PROMPT = `You are a read-only Agent Explorer. Your sole job: search, read, and summarize — NEVER modify, write, or delete anything. Use grep/list_dir/read_file to explore the codebase, web_search to look up information online, and run_browser to read pages web_search can't fetch. Fan out broadly, then synthesize. Return a concise, factual summary under ~1000 words.`;

const MAX_RESULT_CHARS = 8000;
/** Cap on the error detail recorded in the access log (keeps the log file lean). */
const MAX_ERROR_CHARS = 8000;
/** Default maxIterations — same as Agent class default. */
const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Format an error for the access log. Captures as much diagnostic detail as
 * possible: the message + stack, and (for native fetch failures) the undici
 * `cause` chain which carries the real socket/DNS error code (ECONNRESET,
 * ENOTFOUND, etc.) that the thin "fetch failed" message hides. Capped at
 * MAX_ERROR_CHARS so a runaway error can't bloat the log file.
 */
function formatError(err: unknown): string {
  const e = err as Error;
  const parts: string[] = [];
  const msg = e?.message ?? String(err);
  parts.push(msg);
  // Walk the cause chain (Node/undici sets Error.cause on fetch rejections).
  let cause = e?.cause as unknown;
  let depth = 0;
  while (cause && depth < 3) {
    const ce = cause as { message?: string; code?: string; cause?: unknown };
    if (ce?.message) parts.push(`  Caused by: ${ce.message}`);
    if (ce?.code) parts.push(`  Code: ${ce.code}`);
    cause = ce?.cause;
    depth++;
  }
  if (e?.stack) parts.push(e.stack);
  const text = parts.join("\n").trim();
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}\n\n[truncated — ${text.length - MAX_ERROR_CHARS} chars]`
    : text;
}

/**
 * Extract the raw LLM request body a provider attached to its thrown Error
 * (see openai-compatible.ts / openai-responses.ts). Returns undefined when the
 * error carries no body (network failure before request, success path, etc.).
 */
function extractRequestBody(err: unknown): string | undefined {
  const body = (err as { requestBody?: string })?.requestBody;
  return body && body.length > 0 ? body : undefined;
}

/**
 * Tool allow-list for the Agent Explorer preset. Read-only filesystem tools
 * plus read-only web tools (web_search + run_browser), filtered to whatever
 * the parent registry actually has registered (see buildSubRegistry).
 */
const AGENT_EXPLORER_TOOLS = new Set(["read_file", "grep", "list_dir", "exec", "web_search", "run_browser"]);

interface AgentGeneralToolArgs {
  task: string;
  tools?: string[];
}

/** Build a sub-registry filtered to delegated tools (or read-only preset for Agent Explorer), always excluding the agent tools themselves (no recursion). */
function buildSubRegistry(parentRegistry: ToolRegistry, requested: Set<string> | null): ToolRegistry {
  const subRegistry = new ToolRegistry();
  for (const t of parentRegistry.list()) {
    if (t.name === "agent_general" || t.name === "agent_explorer") continue;
    if (requested && !requested.has(t.name)) continue;
    subRegistry.register(t);
  }
  return subRegistry;
}

/** Run a context-isolated Agent General / Agent Explorer and return its final text result. */
async function runAgent(
  task: string,
  parentProvider: Provider,
  subRegistry: ToolRegistry,
  systemPrompt: string,
  ctx: import("../base.js").ToolContext,
  parentMaxIterations: number,
): Promise<string> {
  const subAgent = new Agent({
    provider: parentProvider,
    registry: subRegistry,
    model: parentProvider.defaultModel,
    systemPrompt,
    projectDir: ctx.projectDir,
    maxIterations: parentMaxIterations,
    requestDelayMs: 0,
    tasksEnabled: false,
    autoContinue: false,
    preTruncate: ctx.preTruncate !== false,
    ...(ctx.askUser ? { askUser: ctx.askUser } : {}),
    ...(ctx.botScript ? { botScript: ctx.botScript } : {}),
    ...(ctx.uploadDir ? { uploadDir: ctx.uploadDir } : {}),
  });
  return subAgent.send(task, {
    onToolCallStart: (_i, name) => ctx.subagentProgress?.("tool", name),
    onToolResult: (_i, name, res) => {
      const preview = res.length > 80 ? `${res.slice(0, 77)}…` : res;
      ctx.subagentProgress?.("tool_done", `${name}: ${preview}`);
    },
  });
}

/** Create the Agent General tool — delegates a task to a focused helper agent (delegated tools, clean context). */
export function createAgentGeneralTool(
  parentProvider: Provider,
  parentRegistry: ToolRegistry,
  parentMaxIterations?: number,
): Tool {
  const maxIter = parentMaxIterations ?? DEFAULT_MAX_ITERATIONS;
  return {
    name: "agent_general",
    description:
      "Delegate a task to a focused helper agent (Agent General) that works independently and returns a summary of what it did. Use this to keep your own context clean when a task needs many tool calls (e.g. multi-file refactors, complex searches). The helper gets the tools you specify and returns its result as text.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the helper should do. Include all needed context — it has no conversation history." },
        tools: { type: "array", items: { type: "string" }, description: 'Tool names the helper may use. Default: all your tools.' },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const { task, tools } = args as AgentGeneralToolArgs;
      const log = (status: "success" | "error", error?: string, requestBody?: string) =>
        ctx.agentAccessLogger?.({
          userId: ctx.userId ?? "unknown",
          tool: "agent_general",
          task,
          model: parentProvider.defaultModel,
          status,
          ...(error ? { error } : {}),
          ...(requestBody ? { requestBody } : {}),
        });
      if (!task?.trim()) {
        log("error", "task is required");
        return "Error: task is required.";
      }
      const progress = ctx.subagentProgress;
      const requested = tools?.length ? new Set(tools) : null;
      const subRegistry = buildSubRegistry(parentRegistry, requested);
      if (subRegistry.list().length === 0) {
        progress?.("error", "no tools delegated");
        log("error", "no tools delegated");
        return "Error: no tools delegated to Agent General.";
      }
      progress?.("thinking", `${subRegistry.list().length} tools`);
      let result: string;
      try {
        result = await runAgent(task, parentProvider, subRegistry, AGENT_GENERAL_SYSTEM_PROMPT, ctx, maxIter);
      } catch (err) {
        const detail = formatError(err);
        progress?.("error", (err as Error).message);
        log("error", detail, extractRequestBody(err));
        return `Error: Agent General failed — ${(err as Error).message}`;
      }
      progress?.("done");
      log("success");
      if (result.length > MAX_RESULT_CHARS) return `${result.slice(0, MAX_RESULT_CHARS)}\n\n[truncated — ${result.length - MAX_RESULT_CHARS} chars]`;
      return result || "(Agent General returned no final answer)";
    },
  };
}

/** Create the Agent Explorer tool — a read-only search agent that summarizes what it finds. */
export function createAgentExplorerTool(
  parentProvider: Provider,
  parentRegistry: ToolRegistry,
  parentMaxIterations?: number,
): Tool {
  const maxIter = parentMaxIterations ?? DEFAULT_MAX_ITERATIONS;
  return {
    name: "agent_explorer",
    description:
      "Send a read-only helper (Agent Explorer) to search and summarize, so your own context stays clean. " +
      "It explores the codebase (grep/list_dir/read_file/exec) and looks up information online " +
      "(web_search, run_browser when available) — but cannot modify anything. Use for 'find all X', " +
      "'how does Y work', 'where is Z defined', or any web research.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What to find or understand in the codebase." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const { task } = args as { task: string };
      const log = (status: "success" | "error", error?: string, requestBody?: string) =>
        ctx.agentAccessLogger?.({
          userId: ctx.userId ?? "unknown",
          tool: "agent_explorer",
          task,
          model: parentProvider.defaultModel,
          status,
          ...(error ? { error } : {}),
          ...(requestBody ? { requestBody } : {}),
        });
      if (!task?.trim()) {
        log("error", "task is required");
        return "Error: task is required.";
      }
      const progress = ctx.subagentProgress;
      const subRegistry = buildSubRegistry(parentRegistry, AGENT_EXPLORER_TOOLS);
      if (subRegistry.list().length === 0) {
        progress?.("error", "no read-only tools available");
        log("error", "no read-only tools available");
        return "Error: no read-only tools available for Agent Explorer.";
      }
      progress?.("thinking", "read-only exploration");
      let result: string;
      try {
        result = await runAgent(task, parentProvider, subRegistry, AGENT_EXPLORER_SYSTEM_PROMPT, ctx, maxIter);
      } catch (err) {
        const detail = formatError(err);
        progress?.("error", (err as Error).message);
        log("error", detail, extractRequestBody(err));
        return `Error: Agent Explorer failed — ${(err as Error).message}`;
      }
      progress?.("done");
      log("success");
      if (result.length > MAX_RESULT_CHARS) return `${result.slice(0, MAX_RESULT_CHARS)}\n\n[truncated — ${result.length - MAX_RESULT_CHARS} chars]`;
      return result || "(Agent Explorer returned no results)";
    },
  };
}
