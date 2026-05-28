export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  content: string;
  status: TaskStatus;
}

/**
 * In-memory holder for the active task checklist. The Agent owns one and
 * exposes it to the `task_update` tool via ToolContext. State is re-injected
 * into the model's context each turn (see Agent), so it survives context
 * optimization and is always authoritative.
 */
export class TaskStore {
  private tasks: Task[] = [];

  set(tasks: Task[]): void {
    this.tasks = tasks.map((t) => ({ content: t.content, status: t.status }));
  }

  get(): Task[] {
    return this.tasks;
  }

  get size(): number {
    return this.tasks.length;
  }
}

/** Render the checklist as markdown-ish lines for injection into context. */
export function renderTaskList(tasks: readonly Task[]): string {
  return tasks
    .map((t) => {
      const box =
        t.status === "completed"
          ? "[x]"
          : t.status === "in_progress"
            ? "[~]"
            : "[ ]";
      return `${box} ${t.content}`;
    })
    .join("\n");
}
