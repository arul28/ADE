import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionRunView } from "../../../shared/types";
import { useMissionPolling } from "./useMissionPolling";

const runViewRequestCache = new Map<string, Promise<MissionRunView | null>>();
const RUN_VIEW_SAFETY_POLL_MS = 45_000;

function getRunViewCoalesced(args: {
  requestKey: string;
  missionId: string;
  runId: string | null;
}): Promise<MissionRunView | null> {
  const cached = runViewRequestCache.get(args.requestKey);
  if (cached) return cached;

  const request = window.ade.missions.getRunView({
    missionId: args.missionId,
    runId: args.runId,
  });
  runViewRequestCache.set(args.requestKey, request);
  void request
    .finally(() => {
      if (runViewRequestCache.get(args.requestKey) === request) {
        runViewRequestCache.delete(args.requestKey);
      }
    })
    .catch(() => undefined);
  return request;
}

export function useMissionRunView(missionId: string | null, runId: string | null, active = true) {
  const [runView, setRunView] = useState<MissionRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequestKeyRef = useRef("");
  const requestSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);

  const resolvedMissionId = String(missionId ?? "").trim();
  const resolvedRunId = String(runId ?? "").trim();
  const requestKey = `${resolvedMissionId}::${resolvedRunId}`;

  useEffect(() => {
    activeRequestKeyRef.current = requestKey;
    inFlightRef.current = false;
    pendingRefreshRef.current = false;
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
    if (inFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const requestSeq = ++requestSeqRef.current;
    const currentRequestKey = requestKey;
    try {
      setLoading(true);
      const next = await getRunViewCoalesced({
        requestKey: currentRequestKey,
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
      inFlightRef.current = false;
      if (requestSeq === requestSeqRef.current && activeRequestKeyRef.current === currentRequestKey) {
        setLoading(false);
      }
      if (pendingRefreshRef.current && activeRequestKeyRef.current === currentRequestKey) {
        pendingRefreshRef.current = false;
        void refresh();
      }
    }
  }, [requestKey, resolvedMissionId, runId]);

  useMissionPolling(
    () => {
      void refresh();
    },
    RUN_VIEW_SAFETY_POLL_MS,
    active && Boolean(resolvedMissionId.length),
  );

  useEffect(() => {
    if (!active) return;
    if (!resolvedMissionId.length) return;
    const subscriptionKey = requestKey;
    const unsubscribe = window.ade.missions.subscribeRunView(
      { missionId: resolvedMissionId, runId: runId ?? null },
      (next) => {
        if (activeRequestKeyRef.current !== subscriptionKey) return;
        setRunView(next);
        setLoading(false);
        setError(null);
      },
    );
    return () => {
      pendingRefreshRef.current = false;
      unsubscribe();
    };
  }, [active, requestKey, resolvedMissionId, runId]);

  return { runView, loading, error, refresh };
}
