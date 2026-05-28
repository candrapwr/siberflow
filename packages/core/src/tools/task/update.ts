import type { Task, TaskStatus } from "../../agent/tasks.js";
import type { Tool } from "../base.js";

interface Args {
  tasks: Array<{ content: string; status: TaskStatus }>;
}

const VALID: TaskStatus[] = ["pending", "in_progress", "completed"];

export const taskUpdateTool: Tool = {
  name: "task_update",
  description:
    "Maintain a checklist for a multi-step task. Send the COMPLETE list every time (full replacement) — include all items with their current status. Use 'in_progress' for the one item you're working on now, 'completed' for finished, 'pending' for not started. Call this at the start of a complex task to lay out the plan, and update it as you progress.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "The full task list (replaces the previous list entirely)",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Short imperative description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!ctx.taskStore) {
      return "Error: task tracking is not enabled";
    }
    const { tasks } = args as Args;
    if (!Array.isArray(tasks)) {
      return "Error: 'tasks' must be an array";
    }
    const cleaned: Task[] = [];
    for (const t of tasks) {
      if (typeof t?.content !== "string" || !VALID.includes(t?.status)) {
        return "Error: each task needs a string 'content' and status of pending|in_progress|completed";
      }
      cleaned.push({ content: t.content, status: t.status });
    }
    ctx.taskStore.set(cleaned);
    const done = cleaned.filter((t) => t.status === "completed").length;
    const active = cleaned.find((t) => t.status === "in_progress");
    return active
      ? `Task list updated (${done}/${cleaned.length} done). Now: ${active.content}`
      : `Task list updated (${done}/${cleaned.length} done).`;
  },
};
