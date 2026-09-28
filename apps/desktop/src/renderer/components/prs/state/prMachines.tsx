/**
 * PR ↔ lane ↔ machine, across every machine that holds this project.
 *
 * The PR list itself stays GitHub-sourced (the tab machine's snapshot). What a
 * single machine cannot know is that a PR's lane lives on ANOTHER machine: the
 * PR row sits in the `.ade` database of the machine that owns the lane, so the
 * tab machine's snapshot reports it as unmapped. This module merges every other
 * machine's mapped PRs (`crossMachineLanesByMachineId[*].prs`, carried by the
 * union the Work tab already maintains) so the list can show that lane, with its
 * machine, and route "open lane" there.
 *
 * Invariant (the wrong-machine bug class): a foreign lane id is never written
 * into a snapshot item's `linkedLaneId` / `linkedPrId`. Those fields feed calls
 * that go to the tab machine; a foreign id there would address the wrong
 * machine. Foreign links travel only through `PrMachineIndex`.
 */

import { createContext, useContext, useMemo } from "react";
import type { GitHubPrListItem, LaneSummary, OpenProjectBinding, PrSummary } from "../../../../shared/types";
import {
  machineChipForTarget,
  type MachineChipModel,
  offlineMessage,
  useProjectMachineTargets,
  type ProjectMachineTarget,
} from "../../history/projectMachines";

export type ForeignPrLink = {
  pr: PrSummary;
  lane: LaneSummary | null;
  target: ProjectMachineTarget;
  /** Null when the project is on one machine. */
  chip: MachineChipModel | null;
  /** Non-null while the owning machine is unreachable. */
  offlineMessage: string | null;
};

export type PrMachineIndex = {
  targets: readonly ProjectMachineTarget[];
  /** The machine the tab is bound to. */
  boundTarget: ProjectMachineTarget | null;
  /** Chip for rows whose lane is on the tab's machine; null on a one-machine project. */
  boundChip: MachineChipModel | null;
  /** Coordinate key → the other machine that owns this PR's lane. */
  foreignByCoord: ReadonlyMap<string, ForeignPrLink>;
  /** Every machine's non-archived lanes, for "does this branch already have a lane anywhere". */
  allLanes: readonly LaneSummary[];
};

export function prCoordKey(pr: { repoOwner: string; repoName: string; githubPrNumber: number }): string {
  return `${pr.repoOwner.trim().toLowerCase()}/${pr.repoName.trim().toLowerCase()}#${Number(pr.githubPrNumber)}`;
}

const EMPTY_INDEX: PrMachineIndex = {
  targets: [],
  boundTarget: null,
  boundChip: null,
  foreignByCoord: new Map(),
  allLanes: [],
};

export function buildPrMachineIndex(targets: readonly ProjectMachineTarget[]): PrMachineIndex {
  const boundTarget = targets.find((target) => target.isActive) ?? null;
  const foreignByCoord = new Map<string, ForeignPrLink>();
  const allLanes: LaneSummary[] = [];
  for (const target of targets) {
    for (const lane of target.lanes) {
      if (!lane.archivedAt) allLanes.push(lane);
    }
    if (target.isActive) continue;
    const chip = machineChipForTarget(target, targets);
    for (const pr of target.prs) {
      if (!pr.laneId || pr.unmapped) continue;
      const key = prCoordKey(pr);
      // First machine wins; an online owner beats a stale offline copy.
      const existing = foreignByCoord.get(key);
      if (existing && (existing.target.online || !target.online)) continue;
      foreignByCoord.set(key, {
        pr,
        lane: target.lanes.find((lane) => lane.id === pr.laneId) ?? null,
        target,
        chip,
        offlineMessage: target.online ? null : offlineMessage(target),
      });
    }
  }
  return {
    targets,
    boundTarget,
    boundChip: machineChipForTarget(boundTarget, targets),
    foreignByCoord,
    allLanes,
  };
}

export function usePrMachineIndex(active: boolean): PrMachineIndex {
  const targets = useProjectMachineTargets(active);
  return useMemo(() => buildPrMachineIndex(targets), [targets]);
}

/**
 * The foreign owner of a GitHub row, or null when the tab machine owns it (or
 * nobody does). A row the tab machine has linked is never foreign, whatever a
 * stale copy elsewhere says.
 */
export function foreignLinkForItem(
  index: PrMachineIndex,
  item: Pick<GitHubPrListItem, "repoOwner" | "repoName" | "githubPrNumber" | "linkedPrId" | "linkedLaneId">,
  hasLocalPr: boolean,
): ForeignPrLink | null {
  if (hasLocalPr) return null;
  // A link id this machine can resolve is this machine's. One it can't (a
  // stale or replicated id) defers to the machine that actually owns the lane.
  if (item.linkedLaneId && index.boundTarget?.lanes.some((lane) => lane.id === item.linkedLaneId)) return null;
  if (index.foreignByCoord.size === 0) return null;
  return index.foreignByCoord.get(prCoordKey(item)) ?? null;
}

const PrMachineIndexContext = createContext<PrMachineIndex>(EMPTY_INDEX);

export const PrMachineIndexProvider = PrMachineIndexContext.Provider;

export function usePrMachineIndexContext(): PrMachineIndex {
  return useContext(PrMachineIndexContext);
}

// ── Runtime pin for one PR's calls ───────────────────────────────────────────

/**
 * The machine every call about the PR in this subtree must reach. `null` (the
 * default) is the tab's own machine: calls stay byte-for-byte unpinned. The
 * detail pane and a foreign row's menu set it to the lane owner's binding, so
 * land/sync/resolve/manage-lane run where the lane and its PR row live.
 */
const PrRuntimePinContext = createContext<OpenProjectBinding | null>(null);

export const PrRuntimePinProvider = PrRuntimePinContext.Provider;

export function usePrRuntimePin(): OpenProjectBinding | null {
  return useContext(PrRuntimePinContext);
}

/**
 * Trailing pin argument: nothing for the tab's machine (so the unpinned call
 * is unchanged, arity included), `[pin]` for another machine.
 */
export function pinArg(pin: OpenProjectBinding | null | undefined): [] | [OpenProjectBinding] {
  return pin ? [pin] : [];
}
