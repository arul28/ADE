import { describe, expect, it } from "vitest";
import type { IntegrationProposal, LaneSummary } from "../../shared/types";
import {
  buildIntegrationSourcesByLaneId,
  isHeuristicIntegrationLane,
  isIntegrationLaneFromMetadata,
} from "./integrationLanes";

function makeLane(id: string, name: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name,
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `refs/heads/${name}`,
    worktreePath: `/tmp/${id}`,
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-10T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<IntegrationProposal> = {}): IntegrationProposal {
  return {
    proposalId: "proposal-1",
    sourceLaneIds: ["lane-a", "lane-b"],
    baseBranch: "main",
    pairwiseResults: [],
    laneSummaries: [],
    steps: [],
    overallOutcome: "conflict",
    createdAt: "2026-03-10T00:00:00.000Z",
    status: "proposed",
    integrationLaneId: "lane-integration",
    ...overrides,
  };
}

describe("integrationLanes", () => {
  it("maps integration lanes to readable source lane names", () => {
    const lanes = [
      makeLane("lane-a", "auth"),
      makeLane("lane-b", "billing"),
      makeLane("lane-integration", "integration/pr-123"),
    ];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    const map = buildIntegrationSourcesByLaneId([makeProposal()], laneById);

    expect(map.get("lane-integration")).toEqual([
      { laneId: "lane-a", laneName: "auth" },
      { laneId: "lane-b", laneName: "billing" },
    ]);
  });

  it("uses metadata before falling back to name/description heuristics", () => {
    const regularLane = makeLane("lane-feature", "feature/auth");
    const heuristicLane = makeLane("lane-int", "integration/preview");
    const map = new Map([
      ["lane-feature", [{ laneId: "lane-a", laneName: "auth" }]],
    ]);

    expect(isIntegrationLaneFromMetadata(regularLane, map)).toBe(true);
    expect(isHeuristicIntegrationLane(heuristicLane)).toBe(true);
  });
});
