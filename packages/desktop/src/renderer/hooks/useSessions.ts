// Session list state: loads sessions, exposes new/load/delete helpers.

import { useCallback, useEffect, useState } from "react";
import { ipc } from "../ipc.js";
import type { SessionSummary } from "@shared/protocol";

export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = useCallback(async (projectDir?: string) => {
    const list = await ipc().listSessions(projectDir);
    setSessions(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const newSession = useCallback(
    async (folderPath: string | null, name: string | null) => {
      const info = await ipc().newSession(folderPath, name);
      setActiveId(info.id);
      await refresh();
      return info;
    },
    [refresh],
  );

  const loadSession = useCallback(
    async (id: string) => {
      await ipc().loadSession(id);
      setActiveId(id);
    },
    [],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await ipc().deleteSession(id);
      if (activeId === id) setActiveId(null);
      await refresh();
    },
    [activeId, refresh],
  );

  return { sessions, activeId, setActiveId, refresh, newSession, loadSession, deleteSession };
}
