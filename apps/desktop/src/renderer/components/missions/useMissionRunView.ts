import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionRunView } from "../../../shared/types";
import { useMissionPollingImmediate } from "./useMissionPolling";

export function useMissionRunView(missionId: string | null, runId: string | null) {
  const [runView, setRunView] = useState<MissionRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const activeRequestKeyRef = useRef("");
  const requestSeqRef = useRef(0);

  const resolvedMissionId = String(missionId ?? "").trim();
  const resolvedRunId = String(runId ?? "").trim();
  const requestKey = `${resolvedMissionId}::${resolvedRunId}`;

  useEffect(() => {
    activeRequestKeyRef.current = requestKey;
    setRunView(null);
    setError(null);
    setLoading(Boolean(resolvedMissionId.length));
  }, [requestKey, resolvedMissionId]);

  const refresh = useCallback(async () => {
    if (!resolvedMissionId.length) {
      setRunView(null);
      setLoading(false);
      setError(null);
      return;
    }
    const requestSeq = ++requestSeqRef.current;
    const currentRequestKey = requestKey;
    try {
      setLoading(true);
      const next = await window.ade.missions.getRunView({
        missionId: resolvedMissionId,
        runId: runId ?? null,
      });
      if (requestSeq !== requestSeqRef.current || activeRequestKeyRef.current !== currentRequestKey) {
        return;
      }
      setRunView(next);
      setError(null);
    } catch (err) {
      if (requestSeq !== requestSeqRef.current || activeRequestKeyRef.current !== currentRequestKey) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestSeq === requestSeqRef.current && activeRequestKeyRef.current === currentRequestKey) {
        setLoading(false);
      }
    }
  }, [requestKey, resolvedMissionId, runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pollRefresh = useCallback(() => { void refresh(); }, [refresh]);
  const { fireNow } = useMissionPollingImmediate(pollRefresh, 10_000, Boolean(missionId));

  useEffect(() => {
    if (!resolvedMissionId.length) return;
    const subscriptionKey = requestKey;
    const unsubscribe = window.ade.missions.subscribeRunView(
      { missionId: resolvedMissionId, runId: runId ?? null },
      (next) => {
        if (activeRequestKeyRef.current !== subscriptionKey) return;
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
  }, [fireNow, requestKey, resolvedMissionId]);

  return { runView, loading, error, refresh };
}
