import { useEffect, useMemo, useRef, useState } from "react";
import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";
import type { LaneSummary, OpenProjectBinding, RebaseNeed } from "../../../shared/types";
import { foreignLaneKey } from "../../state/laneMachineRouting";
import { callEachMachine, pinKeys, useEachMachineSubscription } from "../../state/repositoryScope";

/** Wait this long after the Lanes tab shows before the first scan, so first paint stays local. */
const FIRST_SCAN_DELAY_MS = 600;
/** A finished rebase moves the lane; scan again once things settle. */
const RESCAN_AFTER_REBASE_MS = 1_000;

/** Coming back to the tab within this window reuses the last scan instead of starting one. */
const RESCAN_AFTER_MS = 30_000;

const EMPTY_NEEDS: ReadonlyMap<string, RebaseNeed> = new Map();

/** One scan per machine copy at a time, keyed by the copy's address. */
const scanInFlight = new Map<string, Promise<RebaseNeed[]>>();
/** Mounted scanners, so a catch-up that did not go through the rebase engine (a merge) can ask for a fresh scan. */
const rescanRequests = new Set<() => void>();

/**
 * Scan the lanes again shortly, as a finished rebase does. A merge of the
 * base sends no rebase event, and a "built on merged work" need would
 * otherwise stay until the next scan.
 */
export function requestLaneRebaseNeedsRescan(): void {
  for (const request of rescanRequests) request();
}
/** The last needs each machine copy reported (scan or pushed event), so a revisit paints at once. */
const lastNeedsByPin = new Map<string, { needs: ReadonlyMap<string, RebaseNeed>; atMs: number }>();

/**
 * One scan per copy at a time: a Lanes page that remounts while a scan is in
 * flight joins it. The PRs tab's rebase views run their own scans.
 */
function scanRebaseNeedsCoalesced(pin: OpenProjectBinding): Promise<RebaseNeed[]> {
  const existing = scanInFlight.get(pin.key);
  if (existing) return existing;
  const promise = window.ade.rebase.scanNeeds(pin).finally(() => {
    if (scanInFlight.get(pin.key) === promise) scanInFlight.delete(pin.key);
  });
  scanInFlight.set(pin.key, promise);
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

/** One machine whose lanes the page lists. */
export type LaneRebaseScanMachine = {
  /** The machine's copy of the repository. */
  pin: OpenProjectBinding;
  /** Null for the tab's own copy, whose rows are keyed by lane id; else the machine id of its row keys. */
  machineId: string | null;
};

function rowKeyFor(machine: LaneRebaseScanMachine, laneId: string): string {
  return machine.machineId ? foreignLaneKey(machine.machineId, laneId) : laneId;
}

/**
 * Rebase needs for the lanes of every listed machine, keyed by row key (the
 * lane id for the tab's copy, `machineId:laneId` for another machine).
 *
 * One scan for each machine shortly after the tab shows (skipped when that
 * machine's last one is under 30 s old), then whatever each brain pushes in
 * `rebase-needs-updated`, plus one rescan of that machine after a rebase
 * finishes. No timer polls it. With no machine online, nothing is sent.
 */
export function useLaneRebaseNeeds(
  active: boolean,
  machines: readonly LaneRebaseScanMachine[],
): ReadonlyMap<string, RebaseNeed> {
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const pins = useMemo(() => machines.map((machine) => machine.pin), [machines]);
  const keys = pinKeys(pins);
  const shapeKey = machines.map((machine) => `${machine.pin.key}\t${machine.machineId ?? ""}`).join("\n");
  const tabPinKey = machines.find((machine) => machine.machineId == null)?.pin.key ?? null;
  // Bumped whenever a machine's cached needs change, so the merged map re-reads them.
  const [version, setVersion] = useState(0);
  const rescanTimersRef = useRef(new Map<string, number>());

  const apply = (pinKey: string, next: readonly RebaseNeed[]) => {
    lastNeedsByPin.set(pinKey, { needs: needsByLaneId(next), atMs: Date.now() });
    setVersion((value) => value + 1);
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const scan = (targets: readonly OpenProjectBinding[]) => {
    if (targets.length === 0) return;
    void callEachMachine(targets, scanRebaseNeedsCoalesced, { tabPinKey }).then((results) => {
      for (const result of results) {
        // A machine that cannot scan keeps its rows on each lane's behind count.
        if (result.ok) applyRef.current(result.pin.key, result.value);
      }
    });
  };
  const scanRef = useRef(scan);
  scanRef.current = scan;

  const scheduleRescan = (pin: OpenProjectBinding) => {
    const timers = rescanTimersRef.current;
    const pending = timers.get(pin.key);
    if (pending != null) window.clearTimeout(pending);
    timers.set(pin.key, window.setTimeout(() => {
      timers.delete(pin.key);
      scanRef.current([pin]);
    }, RESCAN_AFTER_REBASE_MS));
  };
  const scheduleRescanRef = useRef(scheduleRescan);
  scheduleRescanRef.current = scheduleRescan;

  // The first scan of each machine, and a rescan of all of them on request.
  useEffect(() => {
    if (!active || keys.length === 0 || !window.ade?.rebase) return;
    let cancelled = false;
    const current = machinesRef.current.map((machine) => machine.pin);
    const stale = current.filter((pin) => {
      const last = lastNeedsByPin.get(pin.key);
      return !last || Date.now() - last.atMs >= RESCAN_AFTER_MS;
    });
    const firstScan = stale.length > 0
      ? window.setTimeout(() => {
        if (!cancelled) scanRef.current(stale);
      }, FIRST_SCAN_DELAY_MS)
      : null;
    const rescanAll = () => {
      for (const pin of machinesRef.current.map((machine) => machine.pin)) scheduleRescanRef.current(pin);
    };
    rescanRequests.add(rescanAll);
    return () => {
      cancelled = true;
      rescanRequests.delete(rescanAll);
      if (firstScan != null) window.clearTimeout(firstScan);
    };
  }, [active, keys]);

  useEffect(() => () => {
    for (const timer of rescanTimersRef.current.values()) window.clearTimeout(timer);
    rescanTimersRef.current.clear();
  }, []);

  // One event subscription for each machine, kept while the page is active.
  useEachMachineSubscription(active ? pins : NO_PINS, (pin) => window.ade.rebase.onEvent((event) => {
    if (event.type === "rebase-needs-updated") {
      applyRef.current(pin.key, event.needs);
      return;
    }
    if (event.type === "rebase-completed") scheduleRescanRef.current(pin);
  }, pin));

  return useMemo(() => {
    void version;
    const merged = new Map<string, RebaseNeed>();
    for (const machine of machinesRef.current) {
      const needs = lastNeedsByPin.get(machine.pin.key)?.needs ?? EMPTY_NEEDS;
      for (const [laneId, need] of needs) merged.set(rowKeyFor(machine, laneId), need);
    }
    return merged.size > 0 ? merged : EMPTY_NEEDS;
    // `shapeKey` carries the machines; `version` the cached needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey, version]);
}

const NO_PINS: readonly OpenProjectBinding[] = [];

/** What the lane's quiet "behind" line says, and what its Catch up menu needs. */
export type LaneRebaseLine = {
  kind: RebaseNeed["kind"];
  behindBy: number;
  baseBranch: string;
  text: string;
  title: string;
  /**
   * The files the scan expects to conflict; empty when none, or when no scan
   * covers the lane yet. The Catch up menu runs its own check before offering
   * a direct way.
   */
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
    conflictingFiles,
    mergedPrNumber: null,
  };
}
