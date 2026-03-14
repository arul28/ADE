import type { PrMergeContext } from "../../../../shared/types";

export type IntegrationPrLiveModel = {
  isCommittedIntegration: boolean;
  provenanceLaneIds: string[];
  liveSourceLaneIds: string[];
  integrationLaneId: string | null;
  baseLaneId: string | null;
  liveScenario: "single-merge" | "integration-merge";
};

function getTrimmedLaneId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function deriveIntegrationPrLiveModel(args: {
  prLaneId: string;
  mergeContext: PrMergeContext | null;
}): IntegrationPrLiveModel {
  const { mergeContext, prLaneId } = args;
  const provenanceLaneIds =
    Array.isArray(mergeContext?.sourceLaneIds) && mergeContext.sourceLaneIds.length > 0
      ? mergeContext.sourceLaneIds
      : [prLaneId];
  const integrationLaneId = getTrimmedLaneId(mergeContext?.integrationLaneId);
  const isCommittedIntegration = mergeContext?.groupType === "integration" && integrationLaneId !== null;
  const liveSourceLaneIds = isCommittedIntegration ? [integrationLaneId] : provenanceLaneIds;

  return {
    isCommittedIntegration,
    provenanceLaneIds,
    liveSourceLaneIds,
    integrationLaneId,
    baseLaneId: mergeContext?.targetLaneId ?? null,
    liveScenario: liveSourceLaneIds.length > 1 ? "integration-merge" : "single-merge"
  };
}
