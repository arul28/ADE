import { useEffect, useState } from "react";
import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";
import type { LaneSummary, RebaseNeed } from "../../../shared/types";
import { useActiveProjectRoot } from "../../state/appStore";

/** Wait this long after the Lanes tab shows before the first scan, so first paint stays local. */
const FIRST_SCAN_DELAY_MS = 600;
/** A finished rebase moves the lane; scan again once things settle. */
const RESCAN_AFTER_REBASE_MS = 1_000;

/** Coming back to the tab within this window reuses the last scan instead of starting one. */
const RESCAN_AFTER_MS = 30_000;

const EMPTY_NEEDS: ReadonlyMap<string, RebaseNeed> = new Map();

const scanInFlight = new Map<string, Promise<RebaseNeed[]>>();
/** Mounted scanners, so a catch-up that did not go through the rebase engine (a merge) can ask for a fresh scan. */
const rescanRequests = new Set<() => void>();

/**
 * Scan this machine's lanes again shortly, as a finished rebase does. A merge
 * of the base sends no rebase event, and a "built on merged work" need would
 * otherwise stay until the next scan.
 */
export function requestLaneRebaseNeedsRescan(): void {
  for (const request of rescanRequests) request();
}
/** The last needs each project reported (scan or pushed event), so a revisit paints at once. */
const lastNeedsByProject = new Map<string, { needs: ReadonlyMap<string, RebaseNeed>; atMs: number }>();

/**
 * One scan per project at a time: a Lanes page that remounts while a scan is
 * in flight joins it. The PRs tab's rebase views run their own scans.
 */
function scanRebaseNeedsCoalesced(projectKey: string): Promise<RebaseNeed[]> {
  const existing = scanInFlight.get(projectKey);
  if (existing) return existing;
  const promise = window.ade.rebase.scanNeeds().finally(() => {
    if (scanInFlight.get(projectKey) === promise) scanInFlight.delete(projectKey);
  });
  scanInFlight.set(projectKey, promise);
  return promise;
}

function needsByLaneId(needs: readonly RebaseNeed[]): ReadonlyMap<string, RebaseNeed> {
  const map = new Map<string, RebaseNeed>();
  for (const need of needs) {
    // A lane built on merged work says so even when it is also behind.
    const existing = map.get(need.laneId);
    if (!existing || (need.kind === "built_on_merged" && existing.kind !== "built_on_merged")) {
      map.set(need.laneId, need);
    }
  }
  return map;
}

/**
 * Rebase needs for the lanes on the tab's machine, keyed by lane id.
 *
 * One scan shortly after the tab shows (skipped when the last one is under
 * 30 s old), then whatever the brain pushes in `rebase-needs-updated`, plus
 * one rescan after a rebase finishes. No timer polls it. Lanes on other machines are not in this map; their rows fall back
 * to the lane's own behind count.
 */
export function useLaneRebaseNeeds(active: boolean): ReadonlyMap<string, RebaseNeed> {
  const projectRoot = useActiveProjectRoot();
  const [needs, setNeeds] = useState<ReadonlyMap<string, RebaseNeed>>(
    () => (projectRoot ? lastNeedsByProject.get(projectRoot)?.needs : null) ?? EMPTY_NEEDS,
  );

  useEffect(() => {
    setNeeds((projectRoot ? lastNeedsByProject.get(projectRoot)?.needs : null) ?? EMPTY_NEEDS);
  }, [projectRoot]);

  useEffect(() => {
    if (!active || !projectRoot || !window.ade?.rebase) return;
    let cancelled = false;
    let rescanTimer: number | null = null;
    const apply = (next: readonly RebaseNeed[]) => {
      const map = needsByLaneId(next);
      lastNeedsByProject.set(projectRoot, { needs: map, atMs: Date.now() });
      if (!cancelled) setNeeds(map);
    };
    const scan = () => {
      void scanRebaseNeedsCoalesced(projectRoot)
        .then(apply)
        .catch(() => {
          // The rows fall back to each lane's behind count.
        });
    };
    const last = lastNeedsByProject.get(projectRoot);
    const firstScan = last && Date.now() - last.atMs < RESCAN_AFTER_MS
      ? null
      : window.setTimeout(scan, FIRST_SCAN_DELAY_MS);
    const scheduleRescan = () => {
      if (rescanTimer != null) window.clearTimeout(rescanTimer);
      rescanTimer = window.setTimeout(() => {
        rescanTimer = null;
        scan();
      }, RESCAN_AFTER_REBASE_MS);
    };
    rescanRequests.add(scheduleRescan);
    const unsubscribe = window.ade.rebase.onEvent((event) => {
      if (event.type === "rebase-needs-updated") {
        apply(event.needs);
        return;
      }
      if (event.type === "rebase-completed") scheduleRescan();
    });
    return () => {
      cancelled = true;
      rescanRequests.delete(scheduleRescan);
      if (firstScan != null) window.clearTimeout(firstScan);
      if (rescanTimer != null) window.clearTimeout(rescanTimer);
      unsubscribe();
    };
  }, [active, projectRoot]);

  return needs;
}

/** What the lane's quiet "behind" line says, and what its Catch up menu needs. */
export type LaneRebaseLine = {
  kind: RebaseNeed["kind"];
  behindBy: number;
  baseBranch: string;
  text: string;
  title: string;
  /**
   * Whether bringing the lane up to date is expected to conflict. Null when
   * no scan covers the lane (a lane on another machine): unknown, not "no".
   */
  conflictPredicted: boolean | null;
  /** The files the scan expects to conflict; empty when none or unknown. */
  conflictingFiles: string[];
  /** For `built_on_merged`: the merged PR whose commits the lane still carries. */
  mergedPrNumber: number | null;
};

/**
 * The branch a lane is compared to and rebases onto. The brain decides it (its
 * open PR's base, else the default branch) and reports it on the lane's
 * status; the lane's own base stands in only when the status lacks it (an
 * older brain, a list read without status).
 */
export function laneCompareBase(lane: Pick<LaneSummary, "baseRef" | "status">): string {
  return branchNameFromLaneRef(lane.status?.compareBase) || branchNameFromLaneRef(lane.baseRef);
}

/**
 * The one quiet line a lane shows when it needs a rebase: "3 behind main" or
 * "Built on work now in main". Null when it needs none, for the Primary
 * lane, and for a lane whose PR merged (catching up finished work is never
 * the next step).
 *
 * The lane's own behind count wins over the scan's when it is set: it comes
 * from the same compare base and is refreshed by every git action.
 */
export function laneRebaseLine(args: {
  lane: Pick<LaneSummary, "laneType" | "baseRef" | "status">;
  need: RebaseNeed | null | undefined;
  merged?: boolean;
}): LaneRebaseLine | null {
  const { lane, need } = args;
  if (lane.laneType === "primary" || args.merged) return null;
  if (lane.status?.rebaseInProgress) return null;
  const conflictPredicted = need ? need.conflictPredicted : null;
  const conflictingFiles = need?.conflictPredicted ? need.conflictingFiles ?? [] : [];
  const baseBranch = branchNameFromLaneRef(need?.baseBranch) || laneCompareBase(lane);
  const statusBehind = lane.status?.behind ?? 0;
  if (need?.kind === "built_on_merged") {
    const prNumber = need.mergedPr?.number;
    return {
      kind: "built_on_merged",
      behindBy: Math.max(statusBehind, need.behindBy),
      baseBranch,
      text: `Built on work now in ${baseBranch}`,
      title: prNumber
        ? `This lane still carries the commits of #${prNumber}, which merged into ${baseBranch}.`
        : `This lane still carries commits that merged into ${baseBranch}.`,
      conflictPredicted,
      conflictingFiles,
      mergedPrNumber: prNumber ?? null,
    };
  }
  const behindBy = statusBehind > 0 ? statusBehind : need?.kind === "behind" ? need.behindBy : 0;
  if (behindBy <= 0) return null;
  const conflict = need?.conflictPredicted ? " Catching up is likely to conflict." : "";
  return {
    kind: "behind",
    behindBy,
    baseBranch,
    text: `${behindBy} behind ${baseBranch}`,
    title: `${behindBy} commit${behindBy === 1 ? "" : "s"} behind ${baseBranch}.${conflict}`,
    conflictPredicted,
    conflictingFiles,
    mergedPrNumber: null,
  };
}
