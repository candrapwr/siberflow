// Collapsible task checklist with a progress bar and plan overview.

import { memo, useMemo, useState } from "react";
import type { Task } from "@siberflow/core";

interface TaskPanelProps {
  tasks: Task[];
  /** Snapshot of the initial task plan (set once per turn via task-plan event). */
  taskPlan: Task[] | null;
}

/**
 * Merge initial plan tasks with current status from live tasks.
 * Keeps planned order but uses the latest status from `tasks`.
 */
function mergePlanWithStatus(
  plan: Task[],
  live: Task[],
): Task[] {
  const liveMap = new Map<string, Task["status"]>();
  for (const t of live) {
    liveMap.set(t.content, t.status);
  }
  return plan.map((t) => ({
    content: t.content,
    status: liveMap.get(t.content) ?? t.status,
  }));
}

export const TaskPanel = memo(function TaskPanel({
  tasks,
  taskPlan,
}: TaskPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  // Use plan if available (gives stable ordering), else fall back to live tasks.
  const displayTasks = useMemo(() => {
    if (taskPlan && taskPlan.length > 0) {
      return mergePlanWithStatus(taskPlan, tasks);
    }
    return tasks;
  }, [taskPlan, tasks]);

  if (displayTasks.length === 0) return null;

  const done = displayTasks.filter((t) => t.status === "completed").length;
  const active = displayTasks.find((t) => t.status === "in_progress");
  const pct = displayTasks.length > 0 ? Math.round((done / displayTasks.length) * 100) : 0;
  const isPlan = !!(taskPlan && taskPlan.length > 0);

  return (
    <div className="task-panel">
      {/* ── Header ── */}
      <div className="task-header" onClick={() => setCollapsed((v) => !v)}>
        <span className="task-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="task-title">
          {isPlan ? "📋 Rencana Kerja" : "tasks"}{" "}
          <b>
            {done}/{displayTasks.length}
          </b>
        </span>
        <div className="task-progress">
          <div className="task-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {!collapsed && (
        <div className="task-body">
          {/* Active step hint */}
          {isPlan && active && (
            <div className="task-active-hint">
              <span className="task-active-dot" />
              Now: <strong>{active.content}</strong>
            </div>
          )}

          {/* Step list */}
          <ol className={`task-steps ${isPlan ? "is-plan" : ""}`}>
            {displayTasks.map((t, i) => (
              <li key={i} className={`task-step ${t.status}`}>
                {/* Status icon */}
                <span className="task-step-icon">
                  {t.status === "completed" ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : t.status === "in_progress" ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="currentColor"
                    >
                      <circle cx="12" cy="12" r="5" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="8" />
                    </svg>
                  )}
                </span>

                {/* Step number (only for plan view) */}
                {isPlan && <span className="task-step-num">{i + 1}.</span>}

                {/* Content */}
                <span className="task-step-text">{t.content}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
});
