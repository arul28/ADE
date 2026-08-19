/**
 * Hooks over `window.ade.laneEvents`.
 *
 * Event-driven only: there is no polling loop here. Refreshes happen on the
 * runtime's `onChanged` push (coalesced) and on window focus, per the Lanes
 * perf rules — a hidden Lanes tab must not keep asking the daemon for stories.
 * Both hooks tolerate a runtime that does not implement the action yet: the
 * preload contract resolves to an empty result and the UI shows its quiet
 * "no story yet" state rather than an error.
 *
 * Both hooks take `active`. The Lanes route stays mounted while parked on
 * another tab, so an inactive hook does nothing at all: no read, no `onChanged`
 * subscription, no focus listener. Going active does one fresh load.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LaneEventsListResult,
  LaneEventsSummary,
} from "../../../../shared/types/laneEvents";
import { emptyLaneEventsListResult } from "../../../../shared/types/laneEvents";
import { LANES_INVALIDATED_LANE_ID } from "../../../../shared/types/lanes";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";

const REFRESH_COALESCE_MS = 300;

/**
 * The refresh machinery both hooks share: one coalescing timer, a fresh load
 * whenever the loader identity or the project changes, and — only while active
 * — the runtime push + window focus triggers.
 */
function useCoalescedRefresh(
  load: () => void | Promise<void>,
  opts: {
    active: boolean;
    /** Subscription identity: null means there is nothing to listen for yet. */
    key: string | null;
    /** When set, pushes for other lanes are ignored. Summaries watch every lane. */
    filterLaneId?: string | null;
  },
): () => void {
  const { active, key, filterLaneId = null } = opts;
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const timerRef = useRef<number | null>(null);

  const schedule = useCallback(() => {
    if (timerRef.current != null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void load();
    }, REFRESH_COALESCE_MS);
  }, [load]);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, load, projectRoot]);

  useEffect(() => {
    if (!active || !key) return;
    const off = window.ade.laneEvents.onChanged?.((event) => {
      // The hosted web adapter has no per-lane push: it re-emits CRR lane
      // invalidations under a wildcard lane id, which must not be filtered out.
      if (
        filterLaneId &&
        event?.laneId &&
        event.laneId !== filterLaneId &&
        event.laneId !== LANES_INVALIDATED_LANE_ID
      ) {
        return;
      }
      schedule();
    });
    const onFocus = () => schedule();
    window.addEventListener("focus", onFocus);
    return () => {
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [active, filterLaneId, key, schedule]);

  return schedule;
}

export type LaneEventsState = {
  result: LaneEventsListResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function useLaneEvents(laneId: string | null, active = true): LaneEventsState {
  const [result, setResult] = useState<LaneEventsListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!laneId) {
      setResult(null);
      setError(null);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const next = await window.ade.laneEvents.list({ laneId });
      if (requestIdRef.current !== requestId) return;
      setResult(next ?? emptyLaneEventsListResult(laneId));
      setError(null);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setResult(emptyLaneEventsListResult(laneId));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [laneId]);

  const schedule = useCoalescedRefresh(load, { active, key: laneId, filterLaneId: laneId });

  return { result, loading, error, refresh: schedule };
}

export function useLaneEventsSummary(
  laneIds: readonly string[],
  active = true,
): Map<string, LaneEventsSummary> {
  const [byLane, setByLane] = useState<Map<string, LaneEventsSummary>>(() => new Map());
  const laneKey = useMemo(() => [...laneIds].sort().join(","), [laneIds]);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const ids = laneKey ? laneKey.split(",") : [];
    if (!ids.length) {
      setByLane(new Map());
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const next = await window.ade.laneEvents.summary({ laneIds: ids });
      if (requestIdRef.current !== requestId) return;
      setByLane(new Map((next?.summaries ?? []).map((summary) => [summary.laneId, summary] as const)));
    } catch {
      if (requestIdRef.current !== requestId) return;
      setByLane(new Map());
    }
  }, [laneKey]);

  useCoalescedRefresh(load, { active, key: laneKey || null });

  return byLane;
}
