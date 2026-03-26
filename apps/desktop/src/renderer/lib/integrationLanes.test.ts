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

  it("returns empty map when given no proposals", () => {
    const lanes = [makeLane("lane-a", "auth")];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    const map = buildIntegrationSourcesByLaneId([], laneById);
    expect(map.size).toBe(0);
  });

  it("returns empty map when lane list is empty", () => {
    const laneById = new Map<string, LaneSummary>();
    const map = buildIntegrationSourcesByLaneId([makeProposal()], laneById);
    expect(map.size).toBe(0);
  });

  it("skips proposals with missing integrationLaneId", () => {
    const lanes = [makeLane("lane-a", "auth")];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    const map = buildIntegrationSourcesByLaneId(
      [makeProposal({ integrationLaneId: "" })],
      laneById,
    );
    expect(map.size).toBe(0);
  });

  it("skips proposals with whitespace-only integrationLaneId", () => {
    const lanes = [makeLane("lane-a", "auth")];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    const map = buildIntegrationSourcesByLaneId(
      [makeProposal({ integrationLaneId: "   " })],
      laneById,
    );
    expect(map.size).toBe(0);
  });

  it("deduplicates source lane entries across multiple proposals for the same integration lane", () => {
    const lanes = [
      makeLane("lane-a", "auth"),
      makeLane("lane-b", "billing"),
      makeLane("lane-c", "payments"),
      makeLane("lane-integration", "integration/pr-123"),
    ];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    const proposals = [
      makeProposal({ proposalId: "p1", sourceLaneIds: ["lane-a", "lane-b"] }),
      makeProposal({ proposalId: "p2", sourceLaneIds: ["lane-b", "lane-c"] }),
    ];
    const map = buildIntegrationSourcesByLaneId(proposals, laneById);

    const sources = map.get("lane-integration")!;
    expect(sources).toHaveLength(3);
    // lane-b should only appear once
    const laneIds = sources.map((s) => s.laneId);
    expect(laneIds).toEqual(["lane-a", "lane-b", "lane-c"]);
  });

  it("warns and skips source lanes that do not exist in laneById", () => {
    const lanes = [
      makeLane("lane-a", "auth"),
      makeLane("lane-integration", "integration/pr-123"),
    ];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    // lane-b does not exist in laneById
    const map = buildIntegrationSourcesByLaneId(
      [makeProposal({ sourceLaneIds: ["lane-a", "lane-nonexistent"] })],
      laneById,
    );

    const sources = map.get("lane-integration")!;
    expect(sources).toHaveLength(1);
    expect(sources[0].laneId).toBe("lane-a");
  });

  it("skips non-string entries in sourceLaneIds", () => {
    const lanes = [
      makeLane("lane-a", "auth"),
      makeLane("lane-integration", "integration/pr-123"),
    ];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    const map = buildIntegrationSourcesByLaneId(
      [makeProposal({ sourceLaneIds: ["lane-a", null as any, undefined as any, 123 as any] })],
      laneById,
    );

    const sources = map.get("lane-integration")!;
    expect(sources).toHaveLength(1);
    expect(sources[0].laneId).toBe("lane-a");
  });

  it("isHeuristicIntegrationLane detects description-based integration lanes", () => {
    const lane = makeLane("lane-x", "some-regular-name", { description: "Integration lane for PR #99" });
    expect(isHeuristicIntegrationLane(lane)).toBe(true);
  });

  it("isHeuristicIntegrationLane returns false for non-integration lanes", () => {
    const lane = makeLane("lane-x", "feature/auth", { description: "Normal feature work" });
    expect(isHeuristicIntegrationLane(lane)).toBe(false);
  });

  it("isIntegrationLaneFromMetadata returns false when lane is absent from both metadata and heuristic", () => {
    const lane = makeLane("lane-x", "feature/auth");
    const emptyMap = new Map<string, { laneId: string; laneName: string }[]>();
    expect(isIntegrationLaneFromMetadata(lane, emptyMap)).toBe(false);
  });
});
