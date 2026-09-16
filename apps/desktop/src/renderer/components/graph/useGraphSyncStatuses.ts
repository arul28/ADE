import * as React from "react";

import type { GitUpstreamSyncStatus, LaneSummary } from "../../../shared/types";

type RefreshScope = "all" | Set<string> | null;
type SyncByLaneId = Partial<Record<string, GitUpstreamSyncStatus | null>>;

type UseGraphSyncStatusesArgs = {
  active: boolean;
  lanes: LaneSummary[];
  lanesRef: React.MutableRefObject<LaneSummary[]>;
  projectRoot: string | null;
};

function graphLaneSyncKey(projectRoot: string | null, lane: LaneSummary): string {
  return [
    projectRoot ?? "",
    lane.baseRef,
    lane.branchRef,
    lane.worktreePath,
    lane.worktreeAvailable ?? "",
    lane.archivedAt ?? "",
  ].join("\u0000");
}

function sameGraphSyncStatus(
  left: GitUpstreamSyncStatus | null | undefined,
  right: GitUpstreamSyncStatus | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.hasUpstream === right.hasUpstream
    && left.upstreamState === right.upstreamState
    && left.upstreamRef === right.upstreamRef
    && left.ahead === right.ahead
    && left.behind === right.behind
    && left.diverged === right.diverged
    && left.recommendedAction === right.recommendedAction;
}

export function useGraphSyncStatuses({
  active,
  lanes,
  lanesRef,
  projectRoot,
}: UseGraphSyncStatusesArgs): {
  refreshLaneSyncStatuses: (laneIds?: string[]) => Promise<void>;
  syncByLaneId: SyncByLaneId;
} {
  const [syncByLaneId, setSyncByLaneId] = React.useState<SyncByLaneId>({});
  const syncRefreshInFlightRef = React.useRef(false);
  const syncRefreshQueuedRef = React.useRef<RefreshScope>(null);
  const syncLaneFingerprintsRef = React.useRef<Record<string, string>>({});
  const syncWasActiveRef = React.useRef(false);
  const projectRootRef = React.useRef(projectRoot);

  React.useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  const refreshLaneSyncStatuses = React.useCallback(async (laneIds?: string[]) => {
    if (syncRefreshInFlightRef.current) {
      if (!laneIds) {
        syncRefreshQueuedRef.current = "all";
      } else if (syncRefreshQueuedRef.current !== "all") {
        const queuedLaneIds = syncRefreshQueuedRef.current ?? new Set<string>();
        for (const laneId of laneIds) queuedLaneIds.add(laneId);
        syncRefreshQueuedRef.current = queuedLaneIds;
      }
      return;
    }
    syncRefreshInFlightRef.current = true;
    const requestProjectRoot = projectRootRef.current;
    try {
      const laneList = lanesRef.current;
      if (laneList.length === 0) {
        setSyncByLaneId({});
        return;
      }
      const requestedIds = laneIds ? new Set(laneIds) : null;
      const lanesToRefresh = requestedIds
        ? laneList.filter((lane) => requestedIds.has(lane.id))
        : laneList;
      if (lanesToRefresh.length === 0) return;

      let refreshed: Record<string, GitUpstreamSyncStatus | null>;
      try {
        refreshed = await window.ade.git.getSyncStatuses({
          laneIds: lanesToRefresh.map((lane) => lane.id),
        });
      } catch {
        refreshed = Object.fromEntries(lanesToRefresh.map((lane) => [lane.id, null]));
      }
      if (projectRootRef.current !== requestProjectRoot) return;

      setSyncByLaneId((previous) => {
        const currentLaneIds = new Set(lanesRef.current.map((lane) => lane.id));
        const next: SyncByLaneId = {};
        for (const [laneId, status] of Object.entries(previous)) {
          if (currentLaneIds.has(laneId)) next[laneId] = status;
        }
        for (const lane of lanesToRefresh) {
          if (currentLaneIds.has(lane.id)) next[lane.id] = refreshed[lane.id] ?? null;
        }
        const previousIds = Object.keys(previous);
        const nextIds = Object.keys(next);
        if (
          previousIds.length === nextIds.length
          && nextIds.every((laneId) => sameGraphSyncStatus(previous[laneId], next[laneId]))
        ) {
          return previous;
        }
        return next;
      });
    } finally {
      syncRefreshInFlightRef.current = false;
      const queued = syncRefreshQueuedRef.current;
      syncRefreshQueuedRef.current = null;
      if (queued) {
        void refreshLaneSyncStatuses(queued === "all" ? undefined : [...queued]);
      }
    }
  }, [lanesRef]);

  React.useEffect(() => {
    if (!active || !projectRoot) {
      syncWasActiveRef.current = false;
      return;
    }
    const previous = syncLaneFingerprintsRef.current;
    const next = Object.fromEntries(lanes.map((lane) => [lane.id, graphLaneSyncKey(projectRoot, lane)]));
    const changedLaneIds = lanes
      .filter((lane) => previous[lane.id] !== next[lane.id])
      .map((lane) => lane.id);
    syncLaneFingerprintsRef.current = next;
    const resumed = !syncWasActiveRef.current;
    syncWasActiveRef.current = true;

    setSyncByLaneId((current) => {
      const activeLaneIds = new Set(lanes.map((lane) => lane.id));
      const pruned: SyncByLaneId = {};
      for (const [laneId, status] of Object.entries(current)) {
        if (activeLaneIds.has(laneId)) pruned[laneId] = status;
      }
      return Object.keys(pruned).length === Object.keys(current).length ? current : pruned;
    });

    if (changedLaneIds.length > 0) {
      void refreshLaneSyncStatuses(changedLaneIds);
    } else if (resumed && lanes.length > 0) {
      void refreshLaneSyncStatuses();
    }
  }, [active, lanes, projectRoot, refreshLaneSyncStatuses]);

  return { refreshLaneSyncStatuses, syncByLaneId };
}
