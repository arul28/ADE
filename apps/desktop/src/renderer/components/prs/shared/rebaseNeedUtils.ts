import type { LaneSummary, RebaseNeed } from "../../../../shared/types";

export type UpstreamRebaseNeed = {
  laneId: string;
  laneName: string;
  kind: RebaseNeed["kind"];
  baseBranch: string;
  behindBy: number;
  conflictPredicted: boolean;
};

export function rebaseNeedItemKey(need: RebaseNeed): string {
  return `${need.laneId}:${need.kind}:${need.prId ?? "base"}:${need.baseBranch}`;
}

export function resolveRouteRebaseSelection(args: {
  rebaseNeeds: RebaseNeed[] | null | undefined;
  routeItemId?: string | null;
}): string | null {
  const routeItemId = (args.routeItemId ?? "").trim();
  if (!routeItemId) return null;

  const rebaseNeeds = args.rebaseNeeds ?? [];
  if (rebaseNeeds.some((need) => rebaseNeedItemKey(need) === routeItemId)) {
    return routeItemId;
  }

  const laneBaseNeed = findLaneBaseNeed(rebaseNeeds, routeItemId);
  if (laneBaseNeed) return rebaseNeedItemKey(laneBaseNeed);

  const matchingNeed = findMatchingRebaseNeed({ rebaseNeeds, laneId: routeItemId });
  return matchingNeed ? rebaseNeedItemKey(matchingNeed) : routeItemId;
}

export function findLaneBaseNeed(rebaseNeeds: RebaseNeed[], laneId: string): RebaseNeed | null {
  return rebaseNeeds.find((need) => need.laneId === laneId && need.kind === "lane_base") ?? null;
}

export function findMatchingRebaseNeed(args: {
  rebaseNeeds: RebaseNeed[] | null | undefined;
  laneId: string;
  baseBranch?: string | null;
  prId?: string | null;
}): RebaseNeed | null {
  const rebaseNeeds = args.rebaseNeeds ?? [];
  const normalizedBaseBranch = (args.baseBranch ?? "").trim();
  const normalizedPrId = (args.prId ?? "").trim();

  if (normalizedPrId) {
    const byPrId = rebaseNeeds.find((need) => need.prId === normalizedPrId);
    if (byPrId) return byPrId;
  }

  if (normalizedBaseBranch) {
    const exact = rebaseNeeds.find((need) => {
      return need.laneId === args.laneId && need.baseBranch === normalizedBaseBranch;
    });
    if (exact) return exact;
  }

  return rebaseNeeds.find((need) => need.laneId === args.laneId) ?? null;
}

export function buildUpstreamRebaseChain(args: {
  laneId: string;
  lanes: LaneSummary[] | null | undefined;
  rebaseNeeds: RebaseNeed[] | null | undefined;
}): UpstreamRebaseNeed[] {
  const lanes = args.lanes ?? [];
  const rebaseNeeds = args.rebaseNeeds ?? [];
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const entries: UpstreamRebaseNeed[] = [];
  const visited = new Set<string>();

  let currentLane = laneById.get(args.laneId) ?? null;
  let parentLaneId = currentLane?.parentLaneId ?? null;

  while (parentLaneId && !visited.has(parentLaneId)) {
    visited.add(parentLaneId);
    currentLane = laneById.get(parentLaneId) ?? null;
    if (!currentLane) break;

    const directNeed = findLaneBaseNeed(rebaseNeeds, currentLane.id)
      ?? findMatchingRebaseNeed({ rebaseNeeds, laneId: currentLane.id });
    if (directNeed && directNeed.behindBy > 0) {
      entries.push({
        laneId: currentLane.id,
        laneName: currentLane.name,
        kind: directNeed.kind,
        baseBranch: directNeed.baseBranch,
        behindBy: directNeed.behindBy,
        conflictPredicted: directNeed.conflictPredicted,
      });
    }

    parentLaneId = currentLane.parentLaneId;
  }

  return entries;
}

export function formatUpstreamRebaseSummary(entries: UpstreamRebaseNeed[]): string | null {
  if (!entries.length) return null;

  const terminalEntry = entries[entries.length - 1];
  const suffix = `${terminalEntry.laneName} is ${terminalEntry.behindBy} behind ${terminalEntry.baseBranch}`;
  if (entries.length === 1) return suffix;
  return `${entries.length} ancestors pending; ${suffix}`;
}
