import { useCallback, useEffect, useRef } from "react";

import type { LaneDeleteProgress, LaneSummary } from "../../../shared/types";
import { invalidateSessionListCache } from "../../lib/sessionListCache";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";

function isTerminalDeleteProgress(progress: LaneDeleteProgress): boolean {
  return progress.overallStatus === "completed" || progress.overallStatus === "completed_with_warnings";
}

function deleteProgressMessage(progress: LaneDeleteProgress): string | undefined {
  return progress.steps.find((step) => step.status === "failed")?.errorMessage
    ?? progress.steps.find((step) => step.status === "warning")?.errorMessage
    ?? progress.steps.find((step) => step.status === "warning")?.detail;
}

export function useWorkLaneDeleteProgress({
  active,
  projectRoot,
  lanes,
  refreshSessions,
}: {
  active: boolean;
  projectRoot: string | null;
  lanes: LaneSummary[];
  refreshSessions: () => Promise<unknown>;
}): void {
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const deleteProgressByLaneId = useAppStore((state) => state.laneDeleteProgressByLaneId);
  const setDeleteProgressByLaneId = useAppStore((state) => state.setLaneDeleteProgressByLaneId);
  const lanesByIdRef = useRef(new Map<string, LaneSummary>());
  const deleteProgressByLaneIdRef = useRef(deleteProgressByLaneId);
  const completedRefreshesRef = useRef(new Set<string>());
  const retryRefreshRef = useRef<(progress: LaneDeleteProgress) => void>(() => {});
  const retryTimersRef = useRef(new Map<string, number>());
  const retryAttemptsRef = useRef(new Map<string, number>());
  const activeScopeRef = useRef<string | null>(null);
  const scopeGenerationRef = useRef(0);

  const clearRetryTimers = useCallback(() => {
    for (const timer of retryTimersRef.current.values()) window.clearTimeout(timer);
    retryTimersRef.current.clear();
  }, []);

  useEffect(() => {
    clearRetryTimers();
    retryAttemptsRef.current.clear();
    completedRefreshesRef.current.clear();
    scopeGenerationRef.current += 1;
    activeScopeRef.current = active ? projectRoot : null;
    return () => {
      scopeGenerationRef.current += 1;
      activeScopeRef.current = null;
      clearRetryTimers();
      retryAttemptsRef.current.clear();
      completedRefreshesRef.current.clear();
    };
  }, [active, clearRetryTimers, projectRoot]);

  useEffect(() => {
    lanesByIdRef.current = new Map(lanes.map((lane) => [lane.id, lane]));
  }, [lanes]);

  useEffect(() => {
    deleteProgressByLaneIdRef.current = deleteProgressByLaneId;
  }, [deleteProgressByLaneId]);

  const clearProgress = useCallback((progress: LaneDeleteProgress) => {
    setDeleteProgressByLaneId((current) => {
      if (current[progress.laneId]?.startedAt !== progress.startedAt) return current;
      const next = { ...current };
      delete next[progress.laneId];
      return next;
    });
  }, [setDeleteProgressByLaneId]);

  const refreshAfterDelete = useCallback((progress: LaneDeleteProgress) => {
    const refreshScope = projectRoot;
    if (!active || activeScopeRef.current !== refreshScope) return;
    const refreshGeneration = scopeGenerationRef.current;
    const refreshKey = `${progress.laneId}:${progress.startedAt}`;
    if (completedRefreshesRef.current.has(refreshKey)) return;
    completedRefreshesRef.current.add(refreshKey);
    invalidateSessionListCache();
    void Promise.allSettled([
      refreshLanes({
        includeStatus: false,
        includeSnapshots: false,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      }),
      refreshSessions(),
    ]).then((results) => {
      if (scopeGenerationRef.current !== refreshGeneration || activeScopeRef.current !== refreshScope) return;
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) {
        completedRefreshesRef.current.delete(refreshKey);
        const attempt = (retryAttemptsRef.current.get(refreshKey) ?? 0) + 1;
        retryAttemptsRef.current.set(refreshKey, attempt);
        if (attempt < 3 && !retryTimersRef.current.has(refreshKey)) {
          const timer = window.setTimeout(() => {
            retryTimersRef.current.delete(refreshKey);
            retryRefreshRef.current(progress);
          }, 1_000 * (2 ** (attempt - 1)));
          retryTimersRef.current.set(refreshKey, timer);
          return;
        }
        retryAttemptsRef.current.delete(refreshKey);
        clearProgress(progress);
        showToast({
          title: "Lane deleted, but Work did not refresh",
          message: failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
          tone: "error",
          durationMs: 0,
        });
        return;
      }
      retryAttemptsRef.current.delete(refreshKey);
      clearProgress(progress);
      if (progress.overallStatus === "completed_with_warnings") {
        const laneName = lanesByIdRef.current.get(progress.laneId)?.name ?? progress.laneId;
        showToast({
          title: `Deleted ${laneName} with cleanup warnings`,
          message: deleteProgressMessage(progress),
          tone: "info",
          durationMs: 0,
        });
      }
    });
  }, [active, clearProgress, projectRoot, refreshLanes, refreshSessions]);

  useEffect(() => {
    retryRefreshRef.current = refreshAfterDelete;
  }, [refreshAfterDelete]);

  useEffect(() => {
    if (!active) return;

    const applyProgress = (progress: LaneDeleteProgress) => {
      if (progress.overallStatus === "failed" || progress.overallStatus === "cancelled") {
        clearProgress(progress);
        const laneName = lanesByIdRef.current.get(progress.laneId)?.name ?? progress.laneId;
        showToast({
          title: progress.overallStatus === "cancelled"
            ? `Delete cancelled for ${laneName}`
            : `Could not delete ${laneName}`,
          message: deleteProgressMessage(progress),
          tone: "error",
          durationMs: 0,
        });
        return;
      }

      setDeleteProgressByLaneId((current) => ({ ...current, [progress.laneId]: progress }));
      if (isTerminalDeleteProgress(progress)) refreshAfterDelete(progress);
    };

    const unsubscribe = window.ade.lanes.onDeleteEvent((event) => {
      applyProgress(event.progress);
    });
    const unsubscribeLifecycle = window.ade.lanes.onLifecycleEvent((event) => {
      if (event.type === "lane-deleted") {
        const current = deleteProgressByLaneIdRef.current[event.laneId];
        applyProgress(current
          ? { ...current, overallStatus: "completed", completedAt: new Date().toISOString() }
          : {
              laneId: event.laneId,
              steps: [],
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              overallStatus: "completed",
              cancellable: false,
            });
        return;
      }
      void refreshLanes({ includeStatus: false }).catch(() => {});
    });

    let cancelled = false;
    void window.ade.lanes.listDeleteProgress()
      .then((progresses) => {
        if (cancelled) return;
        for (const progress of progresses) {
          if (progress.overallStatus === "running" || isTerminalDeleteProgress(progress)) {
            applyProgress(progress);
          }
        }
      })
      .catch((error) => {
        console.debug("Failed to hydrate Work lane delete progress:", error);
      });

    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeLifecycle();
    };
  }, [active, clearProgress, refreshAfterDelete, refreshLanes, setDeleteProgressByLaneId]);
}
