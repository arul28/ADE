import type { IntegrationProposal, LaneSummary } from "../../shared/types";

export type IntegrationLaneSource = {
  laneId: string;
  laneName: string;
};

export function isHeuristicIntegrationLane(
  lane: Pick<LaneSummary, "name" | "description">,
): boolean {
  return (
    (typeof lane.description === "string" && lane.description.includes("Integration lane"))
    || lane.name.startsWith("integration/")
  );
}

export function buildIntegrationSourcesByLaneId(
  proposals: IntegrationProposal[],
  laneById: Map<string, Pick<LaneSummary, "id" | "name">>,
): Map<string, IntegrationLaneSource[]> {
  const map = new Map<string, IntegrationLaneSource[]>();

  for (const proposal of proposals) {
    const integrationLaneId = typeof proposal.integrationLaneId === "string"
      ? proposal.integrationLaneId.trim()
      : "";
    if (!integrationLaneId || !laneById.has(integrationLaneId)) continue;

    const seen = new Set((map.get(integrationLaneId) ?? []).map((entry) => entry.laneId));
    const next = [...(map.get(integrationLaneId) ?? [])];

    for (const laneId of proposal.sourceLaneIds) {
      if (typeof laneId !== "string") continue;
      const normalizedLaneId = laneId.trim();
      if (!normalizedLaneId || seen.has(normalizedLaneId)) continue;
      const lane = laneById.get(normalizedLaneId);
      if (!lane) continue;
      seen.add(normalizedLaneId);
      next.push({
        laneId: normalizedLaneId,
        laneName: lane.name,
      });
    }

    if (next.length > 0) {
      map.set(integrationLaneId, next);
    }
  }

  return map;
}

export function isIntegrationLaneFromMetadata(
  lane: Pick<LaneSummary, "id" | "name" | "description">,
  integrationSourcesByLaneId: Map<string, IntegrationLaneSource[]>,
): boolean {
  return integrationSourcesByLaneId.has(lane.id) || isHeuristicIntegrationLane(lane);
}
