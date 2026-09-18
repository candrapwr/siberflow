// Session list state: loads sessions, exposes new/load/delete helpers.

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../ipc.js";
import type { SessionSummary } from "@shared/protocol";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"opening" | "deleting" | null>(null);
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async (projectDir?: string) => {
    setRefreshing(true);
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const list = await ipc().listSessions(projectDir);
      setSessions(list);
      setError(null);
      hasLoadedRef.current = true;
    } catch (e) {
      setError(errorMessage(e, "Could not load chat history."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const newSession = useCallback(
    async (folderPath: string | null, name: string | null) => {
      try {
        const info = await ipc().newSession(folderPath, name);
        setActiveId(info.id);
        await refresh();
        return info;
      } catch (e) {
        setError(errorMessage(e, "Could not create a new chat."));
        return null;
      }
    },
    [refresh],
  );

  const loadSession = useCallback(
    async (id: string) => {
      setBusySessionId(id);
      setBusyAction("opening");
      setError(null);
      try {
        await ipc().loadSession(id);
        setActiveId(id);
      } catch (e) {
        setError(errorMessage(e, "Could not open this chat."));
      } finally {
        setBusySessionId(null);
        setBusyAction(null);
      }
    },
    [],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      setBusySessionId(id);
      setBusyAction("deleting");
      setError(null);
      try {
        await ipc().deleteSession(id);
        if (activeId === id) setActiveId(null);
        await refresh();
      } catch (e) {
        setError(errorMessage(e, "Could not delete this chat."));
      } finally {
        setBusySessionId(null);
        setBusyAction(null);
      }
    },
    [activeId, refresh],
  );

  return {
    sessions,
    activeId,
    setActiveId,
    refresh,
    newSession,
    loadSession,
    deleteSession,
    loading,
    refreshing,
    error,
    busySessionId,
    busyAction,
  };
}
