import type { RebaseNeed } from "../../../../shared/types";

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
