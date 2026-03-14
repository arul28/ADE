import type { LaneSummary } from "../../../shared/types";
import { normalizeBranchName } from "../shared/utils";

export type IntegrationPreflight = {
  baseLane: LaneSummary | null;
  uniqueSourceLaneIds: string[];
  duplicateSourceLaneIds: string[];
  missingSourceLaneIds: string[];
};

export function resolveIntegrationBaseLane(
  lanes: LaneSummary[],
  baseBranch: string,
): LaneSummary | null {
  const normalizedBase = normalizeBranchName(baseBranch ?? "");
  if (!normalizedBase) return null;

  return lanes.find((lane) => {
    return lane.id === normalizedBase || normalizeBranchName(lane.branchRef) === normalizedBase;
  }) ?? null;
}

export function buildIntegrationPreflight(
  lanes: LaneSummary[],
  sourceLaneIds: string[],
  baseBranch: string,
): IntegrationPreflight {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const seen = new Set<string>();
  const uniqueSourceLaneIds: string[] = [];
  const duplicateSourceLaneIds: string[] = [];

  for (const rawLaneId of sourceLaneIds) {
    const laneId = rawLaneId.trim();
    if (!laneId) continue;
    if (seen.has(laneId)) {
      duplicateSourceLaneIds.push(laneId);
      continue;
    }
    seen.add(laneId);
    uniqueSourceLaneIds.push(laneId);
  }

  const missingSourceLaneIds = uniqueSourceLaneIds.filter((laneId) => !laneById.has(laneId));

  return {
    baseLane: resolveIntegrationBaseLane(lanes, baseBranch),
    uniqueSourceLaneIds,
    duplicateSourceLaneIds,
    missingSourceLaneIds,
  };
}
