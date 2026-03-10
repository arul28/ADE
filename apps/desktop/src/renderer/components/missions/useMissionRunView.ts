import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionRunView } from "../../../shared/types";
import { useMissionPollingImmediate } from "./useMissionPolling";

export function useMissionRunView(missionId: string | null, runId: string | null) {
  const [runView, setRunView] = useState<MissionRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const resolvedMissionId = String(missionId ?? "").trim();
    if (!resolvedMissionId.length) {
      setRunView(null);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      setLoading(true);
      const next = await window.ade.missions.getRunView({
        missionId: resolvedMissionId,
        runId: runId ?? null,
      });
      setRunView(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [missionId, runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pollRefresh = useCallback(() => { void refresh(); }, [refresh]);
  const { fireNow } = useMissionPollingImmediate(pollRefresh, 10_000, Boolean(missionId));

  useEffect(() => {
    const resolvedMissionId = String(missionId ?? "").trim();
    if (!resolvedMissionId.length) return;
    const unsubscribe = window.ade.missions.subscribeRunView(
      { missionId: resolvedMissionId, runId: runId ?? null },
      (next) => {
        setRunView(next);
        setError(null);
      },
    );
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [missionId, runId]);

  useEffect(() => {
    const resolvedMissionId = String(missionId ?? "").trim();
    if (!resolvedMissionId.length) return;
    const scheduleRefresh = (delayMs = 250) => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        fireNow();
      }, delayMs);
    };
    const unsubMission = window.ade.missions.onEvent((event) => {
      if (event.missionId !== resolvedMissionId) return;
      scheduleRefresh();
    });
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unsubMission();
    };
  }, [fireNow, missionId]);

  return { runView, loading, error, refresh };
}
