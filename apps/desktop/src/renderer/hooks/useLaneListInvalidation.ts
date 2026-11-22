import { useCallback, useEffect, useRef } from "react";
import type { AppState } from "../state/appStore";
import type { LaneLifecycleEvent, OpenProjectBinding } from "../../shared/types";
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

function selectLatestLifecycleEvent(
  _current: LaneLifecycleEvent | null,
  next: LaneLifecycleEvent,
): LaneLifecycleEvent {
  return next;
}

export function useDebouncedLaneLifecycleRefresh({
  active,
  pin,
  debounceMs,
  onEvent,
  onRefresh,
  selectPendingEvent = selectLatestLifecycleEvent,
}: {
  active: boolean;
  /** The copy whose lane events to hear. Null: no copy online, so no subscription. */
  pin: OpenProjectBinding | null;
  debounceMs: number;
  onEvent?: (event: LaneLifecycleEvent) => void;
  onRefresh: (event: LaneLifecycleEvent) => void;
  selectPendingEvent?: (
    current: LaneLifecycleEvent | null,
    next: LaneLifecycleEvent,
  ) => LaneLifecycleEvent;
}): void {
  const refreshTimerRef = useRef<number | null>(null);
  const pendingHiddenEventRef = useRef<LaneLifecycleEvent | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    const eventPin = pinRef.current;
    if (!active || !eventPin) {
      pendingHiddenEventRef.current = null;
      return;
    }

    const clearRefreshTimer = () => {
      if (refreshTimerRef.current == null) return;
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
    const scheduleRefresh = (event: LaneLifecycleEvent, notifyEvent: boolean) => {
      if (notifyEvent) onEvent?.(event);
      pendingHiddenEventRef.current = selectPendingEvent(
        pendingHiddenEventRef.current,
        event,
      );
      if (document.visibilityState !== "visible") return;
      if (refreshTimerRef.current != null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        const pendingEvent = pendingHiddenEventRef.current;
        pendingHiddenEventRef.current = null;
        onRefresh(pendingEvent ?? event);
      }, debounceMs);
    };
    const refreshPendingIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      const pendingEvent = pendingHiddenEventRef.current;
      if (!pendingEvent) return;
      scheduleRefresh(pendingEvent, false);
    };

    const unsubscribe = window.ade.lanes.onLifecycleEvent((event) => {
      scheduleRefresh(event, true);
    }, eventPin);
    window.addEventListener("focus", refreshPendingIfVisible);
    document.addEventListener("visibilitychange", refreshPendingIfVisible);

    return () => {
      unsubscribe();
      clearRefreshTimer();
      window.removeEventListener("focus", refreshPendingIfVisible);
      document.removeEventListener("visibilitychange", refreshPendingIfVisible);
    };
  }, [active, pinKey, debounceMs, onEvent, onRefresh, selectPendingEvent]);
}

export function useLaneListInvalidation({
  active,
  pin,
  refreshLanes,
  freshnessKey,
  staleMs = LANE_LIST_FOCUS_STALE_MS,
}: {
  active: boolean;
  /** The tab copy whose lane list this refreshes. Null: no copy online. */
  pin: OpenProjectBinding | null;
  refreshLanes: RefreshLanes;
  freshnessKey?: unknown;
  staleMs?: number;
}): void {
  const lifecycleFollowupTimerRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    if (!active) {
      lastRefreshAtRef.current = 0;
      return;
    }
    lastRefreshAtRef.current = Date.now();
  }, [active, freshnessKey]);

  const clearLifecycleFollowupTimer = useCallback(() => {
    if (lifecycleFollowupTimerRef.current == null) return;
    window.clearTimeout(lifecycleFollowupTimerRef.current);
    lifecycleFollowupTimerRef.current = null;
  }, []);

  const runRefresh = useCallback((options: Parameters<RefreshLanes>[0]) => {
    invalidateLaneReadCache();
    lastRefreshAtRef.current = Date.now();
    void refreshLanes(options).catch((error) => {
      console.warn("[Lanes] Failed to refresh lane list after invalidation:", error);
    });
  }, [refreshLanes]);

  const handleLifecycleEvent = useCallback(() => {
    invalidateLaneReadCache();
    clearLifecycleFollowupTimer();
  }, [clearLifecycleFollowupTimer]);

  const handleLifecycleRefresh = useCallback((event: LaneLifecycleEvent) => {
    runRefresh(laneLifecycleRefreshOptions(event));
    clearLifecycleFollowupTimer();
    lifecycleFollowupTimerRef.current = window.setTimeout(() => {
      lifecycleFollowupTimerRef.current = null;
      runRefresh(laneLifecycleRefreshOptions(event));
    }, LANE_LIST_LIFECYCLE_FOLLOWUP_REFRESH_DELAY_MS);
  }, [clearLifecycleFollowupTimer, runRefresh]);

  useDebouncedLaneLifecycleRefresh({
    active,
    pin,
    debounceMs: LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS,
    onEvent: handleLifecycleEvent,
    onRefresh: handleLifecycleRefresh,
    selectPendingEvent: selectPendingLifecycleEvent,
  });

  useEffect(() => {
    if (!active) {
      clearLifecycleFollowupTimer();
      return;
    }

    const clearFocusTimer = () => {
      if (focusTimerRef.current == null) return;
      window.clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    };
    const scheduleStaleFocusRefresh = (delayMs: number) => {
      if (focusTimerRef.current != null) return;
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null;
        runRefresh({
          includeStatus: false,
          includeSnapshots: true,
          includeConflictStatus: true,
        });
      }, delayMs);
    };
    const refreshIfVisibleAndStale = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshAtRef.current < staleMs) return;
      invalidateLaneReadCache();
      scheduleStaleFocusRefresh(LANE_LIST_FOCUS_REFRESH_DEBOUNCE_MS);
    };

    window.addEventListener("focus", refreshIfVisibleAndStale);
    document.addEventListener("visibilitychange", refreshIfVisibleAndStale);

    return () => {
      clearFocusTimer();
      window.removeEventListener("focus", refreshIfVisibleAndStale);
      document.removeEventListener("visibilitychange", refreshIfVisibleAndStale);
    };
  }, [active, clearLifecycleFollowupTimer, runRefresh, staleMs]);
}
