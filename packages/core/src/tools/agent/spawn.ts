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

/** Read-only Agent Explorer prompt — search and read, no modifications. */
const AGENT_EXPLORER_SYSTEM_PROMPT = `You are a read-only Agent Explorer. Your sole job: search, read, and summarize — NEVER modify, write, or delete anything. Return a concise, factual summary of what you found. Use grep/list_dir/read_file to fan out broadly, then synthesize. Keep the result under ~1000 words.`;

const MAX_RESULT_CHARS = 8000;
/** Default maxIterations — same as Agent class default. */
const DEFAULT_MAX_ITERATIONS = 100;

/** Read-only tools allowed in the Agent Explorer preset. */
const AGENT_EXPLORER_TOOLS = new Set(["read_file", "grep", "list_dir", "exec"]);

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
      if (!task?.trim()) return "Error: task is required.";
      const progress = ctx.subagentProgress;
      const requested = tools?.length ? new Set(tools) : null;
      const subRegistry = buildSubRegistry(parentRegistry, requested);
      if (subRegistry.list().length === 0) {
        progress?.("error", "no tools delegated");
        return "Error: no tools delegated to Agent General.";
      }
      progress?.("thinking", `${subRegistry.list().length} tools`);
      const result = await runAgent(task, parentProvider, subRegistry, AGENT_GENERAL_SYSTEM_PROMPT, ctx, maxIter);
      progress?.("done");
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
      "Send a read-only helper (Agent Explorer) to search and read the codebase or information on internet, then return a summary. It cannot modify anything — only look. Use this for questions like 'find all X', 'how does Y work', or 'where is Z defined', so your own context stays clean.",
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
      if (!task?.trim()) return "Error: task is required.";
      const progress = ctx.subagentProgress;
      const subRegistry = buildSubRegistry(parentRegistry, AGENT_EXPLORER_TOOLS);
      if (subRegistry.list().length === 0) {
        progress?.("error", "no read-only tools available");
        return "Error: no read-only tools available for Agent Explorer.";
      }
      progress?.("thinking", "read-only exploration");
      const result = await runAgent(task, parentProvider, subRegistry, AGENT_EXPLORER_SYSTEM_PROMPT, ctx, maxIter);
      progress?.("done");
      if (result.length > MAX_RESULT_CHARS) return `${result.slice(0, MAX_RESULT_CHARS)}\n\n[truncated — ${result.length - MAX_RESULT_CHARS} chars]`;
      return result || "(Agent Explorer returned no results)";
    },
  };
}
