import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionStateDocument } from "../../../shared/types";
import { useMissionPollingImmediate } from "./useMissionPolling";

export function useMissionStateDocument(runId: string | null) {
  const [stateDoc, setStateDoc] = useState<MissionStateDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!runId) {
      setStateDoc(null);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const next = await window.ade.orchestrator.getMissionStateDocument({ runId });
      setStateDoc(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pollRefresh = useCallback(() => { void refresh(); }, [refresh]);
  const { fireNow } = useMissionPollingImmediate(pollRefresh, 10_000, !!runId);

  useEffect(() => {
    if (!runId) return;
    const scheduleRefresh = (delayMs = 250) => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        fireNow();
      }, delayMs);
    };

    const unsubRuntime = window.ade.orchestrator.onEvent((event) => {
      if (event.runId !== runId) return;
      scheduleRefresh();
    });

    const unsubThread = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.runId !== runId) return;
      scheduleRefresh();
    });

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unsubRuntime();
      unsubThread();
    };
  }, [runId, fireNow]);

  return { stateDoc, loading, error, refresh };
}
