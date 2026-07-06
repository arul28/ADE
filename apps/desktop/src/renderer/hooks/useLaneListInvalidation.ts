import { useEffect, useRef } from "react";
import type { AppState } from "../state/appStore";
import type { LaneLifecycleEvent } from "../../shared/types";
import { invalidateLaneReadCache } from "../lib/laneReadCache";

export const LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS = 180;
export const LANE_LIST_LIFECYCLE_FOLLOWUP_REFRESH_DELAY_MS = 1_500;
export const LANE_LIST_FOCUS_REFRESH_DEBOUNCE_MS = 120;
export const LANE_LIST_FOCUS_STALE_MS = 10_000;

type RefreshLanes = AppState["refreshLanes"];

export function laneLifecycleRefreshOptions(event: LaneLifecycleEvent): Parameters<RefreshLanes>[0] {
  const includeStatus = event.type === "lane-created";
  return {
    includeStatus,
    includeSnapshots: true,
    includeConflictStatus: true,
    includeRebaseSuggestions: true,
    includeAutoRebaseStatus: true,
  };
}

function selectPendingLifecycleEvent(
  current: LaneLifecycleEvent | null,
  next: LaneLifecycleEvent,
): LaneLifecycleEvent {
  if (next.type === "lane-created") return next;
  if (current?.type === "lane-created") return current;
  return next;
}

export function useLaneListInvalidation({
  active,
  refreshLanes,
  freshnessKey,
  staleMs = LANE_LIST_FOCUS_STALE_MS,
}: {
  active: boolean;
  refreshLanes: RefreshLanes;
  freshnessKey?: unknown;
  staleMs?: number;
}): void {
  const lifecycleTimerRef = useRef<number | null>(null);
  const lifecycleFollowupTimerRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const lastRefreshAtRef = useRef(0);
  const pendingHiddenLifecycleEventRef = useRef<LaneLifecycleEvent | null>(null);

  useEffect(() => {
    if (!active) {
      lastRefreshAtRef.current = 0;
      pendingHiddenLifecycleEventRef.current = null;
      return;
    }
    lastRefreshAtRef.current = Date.now();
  }, [active, freshnessKey]);

  useEffect(() => {
    if (!active) return;

    const clearLifecycleTimer = () => {
      if (lifecycleTimerRef.current == null) return;
      window.clearTimeout(lifecycleTimerRef.current);
      lifecycleTimerRef.current = null;
    };
    const clearFocusTimer = () => {
      if (focusTimerRef.current == null) return;
      window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    };
    const clearLifecycleFollowupTimer = () => {
      if (lifecycleFollowupTimerRef.current == null) return;
      window.clearTimeout(lifecycleFollowupTimerRef.current);
      lifecycleFollowupTimerRef.current = null;
    };
    const runRefresh = (options: Parameters<RefreshLanes>[0]) => {
      invalidateLaneReadCache();
      lastRefreshAtRef.current = Date.now();
      void refreshLanes(options).catch((error) => {
        console.warn("[Lanes] Failed to refresh lane list after invalidation:", error);
      });
    };
    const scheduleLifecycleFollowupRefresh = (event: LaneLifecycleEvent) => {
      clearLifecycleFollowupTimer();
      lifecycleFollowupTimerRef.current = window.setTimeout(() => {
        lifecycleFollowupTimerRef.current = null;
        runRefresh(laneLifecycleRefreshOptions(event));
      }, LANE_LIST_LIFECYCLE_FOLLOWUP_REFRESH_DELAY_MS);
    };
    const scheduleLifecycleRefresh = (event: LaneLifecycleEvent) => {
      invalidateLaneReadCache();
      clearLifecycleFollowupTimer();
      pendingHiddenLifecycleEventRef.current = selectPendingLifecycleEvent(
        pendingHiddenLifecycleEventRef.current,
        event,
      );
      if (document.visibilityState !== "visible") return;
      if (lifecycleTimerRef.current != null) return;
      lifecycleTimerRef.current = window.setTimeout(() => {
        lifecycleTimerRef.current = null;
        const pendingEvent = pendingHiddenLifecycleEventRef.current;
        pendingHiddenLifecycleEventRef.current = null;
        const refreshEvent = pendingEvent ?? event;
        runRefresh(laneLifecycleRefreshOptions(refreshEvent));
        scheduleLifecycleFollowupRefresh(refreshEvent);
      }, LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS);
    };
    const scheduleStaleFocusRefresh = (delayMs: number) => {
      if (focusTimerRef.current != null) return;
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null;
        runRefresh({
          includeStatus: false,
          includeSnapshots: true,
          includeConflictStatus: true,
          includeRebaseSuggestions: true,
          includeAutoRebaseStatus: true,
        });
      }, delayMs);
    };
    const refreshIfVisibleAndStale = () => {
      if (document.visibilityState !== "visible") return;
      const pendingLifecycle = pendingHiddenLifecycleEventRef.current;
      if (pendingLifecycle) {
        scheduleLifecycleRefresh(pendingLifecycle);
        return;
      }
      if (Date.now() - lastRefreshAtRef.current < staleMs) return;
      invalidateLaneReadCache();
      scheduleStaleFocusRefresh(LANE_LIST_FOCUS_REFRESH_DEBOUNCE_MS);
    };

    const unsubscribe = window.ade.lanes.onLifecycleEvent(scheduleLifecycleRefresh);
    window.addEventListener("focus", refreshIfVisibleAndStale);
    document.addEventListener("visibilitychange", refreshIfVisibleAndStale);

    return () => {
      unsubscribe();
      clearLifecycleTimer();
      clearLifecycleFollowupTimer();
      clearFocusTimer();
      window.removeEventListener("focus", refreshIfVisibleAndStale);
      document.removeEventListener("visibilitychange", refreshIfVisibleAndStale);
    };
  }, [active, refreshLanes, staleMs]);
}
