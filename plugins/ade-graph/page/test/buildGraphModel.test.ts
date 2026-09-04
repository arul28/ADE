/**
 * The edges the canvas draws.
 *
 * `buildGraphModel` is the whole edge decision, and it once shipped with two of
 * its four loops missing: a canvas with flat lanes drew NO line at all, because
 * only a lane with a `parentLaneId` earned a `stack:` edge. These cases pin the
 * two loops that were absent — the `topology:` spoke from the primary lane, and
 * the `risk:` overlap web — plus the view mode each one answers to, so the same
 * deletion cannot pass again.
 */

import { describe, expect, it } from "vitest";

import type { GraphViewMode, LaneSummary } from "../src/lib/types";
import { buildGraphModel, type BuildGraphModelInput } from "../src/lib/buildGraphModel";
import { EMPTY_PLUGIN_GRAPH_OVERLAY } from "../src/lib/pluginGraphNodes";
import { buildDefaultFilter, createSnapshot } from "../src/lib/graphLayout";
import { edgePairKey } from "../src/lib/graphHelpers";

function lane(
  partial: Partial<LaneSummary> & Pick<LaneSummary, "id" | "name" | "laneType">,
): LaneSummary {
  return {
    description: null,
    attachedRootPath: null,
    baseRef: "refs/heads/main",
    branchRef: `refs/heads/${partial.name}`,
    worktreePath: "",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...partial,
  };
}

function input(
  lanes: LaneSummary[],
  overrides: Partial<BuildGraphModelInput> = {},
): BuildGraphModelInput {
  const viewMode: GraphViewMode = overrides.viewMode ?? "stack";
  return {
    lanes,
    viewMode,
    snapshot: { ...createSnapshot(viewMode), filters: buildDefaultFilter() },
    filters: buildDefaultFilter(),
    laneMatchesFilters: () => true,
    statusByLane: new Map(),
    riskByPair: new Map(),
    syncByLaneId: {},
    autoRebaseByLaneId: {},
    activeSessionsByLaneId: {},
    activityScoreByLaneId: {},
    activityBucketByLaneId: {},
    lastActivityByLaneId: {},
    environmentByLaneId: {},
    integrationSourcesByLaneId: new Map(),
    integrationProposals: [],
    prOverlayByPair: new Map(),
    prOverlayByLaneId: new Map(),
    showOverviewRiskEdges: false,
    appearanceDraft: null,
    pluginOverlay: EMPTY_PLUGIN_GRAPH_OVERLAY,
    onPressPluginNode: () => {},
    ...overrides,
  };
}

const PRIMARY = lane({ id: "primary", name: "main", laneType: "primary" });
const FLAT_A = lane({ id: "lane-a", name: "alpha", laneType: "attached" });
const FLAT_B = lane({ id: "lane-b", name: "beta", laneType: "attached" });

describe("topology edges", () => {
  it("draws one spoke from the primary lane to every other flat lane", () => {
    const model = buildGraphModel(input([PRIMARY, FLAT_A, FLAT_B]));
    const topology = model.edges.filter((edge) => edge.data?.edgeType === "topology");

    expect(topology.map((edge) => edge.id).sort()).toEqual([
      "topology:primary:lane-a",
      "topology:primary:lane-b",
    ]);
    expect(topology.every((edge) => edge.source === "primary")).toBe(true);
  });

  it("skips the spoke in Overview when a stack edge already draws the lane", () => {
    const child = lane({ id: "lane-child", name: "child", laneType: "attached", parentLaneId: "lane-a" });
    const lanes = [PRIMARY, FLAT_A, child];

    const overview = buildGraphModel(input(lanes, { viewMode: "all" }));
    expect(overview.edges.filter((edge) => edge.data?.edgeType === "topology").map((edge) => edge.id))
      .toEqual(["topology:primary:lane-a"]);
    expect(overview.edges.filter((edge) => edge.data?.edgeType === "stack").map((edge) => edge.id))
      .toEqual(["stack:lane-a:lane-child"]);

    // Dependencies keeps both, exactly as the compiled canvas did.
    const stack = buildGraphModel(input(lanes, { viewMode: "stack" }));
    expect(stack.edges.filter((edge) => edge.data?.edgeType === "topology").map((edge) => edge.id).sort())
      .toEqual(["topology:primary:lane-a", "topology:primary:lane-child"]);
  });

  it("draws no spoke in Conflict Risk or Activity", () => {
    for (const viewMode of ["risk", "activity"] as const) {
      const model = buildGraphModel(input([PRIMARY, FLAT_A, FLAT_B], { viewMode }));
      expect(model.edges.filter((edge) => edge.data?.edgeType === "topology")).toEqual([]);
    }
  });

  it("hides the spoke when either end is filtered out", () => {
    const model = buildGraphModel(
      input([PRIMARY, FLAT_A, FLAT_B], { laneMatchesFilters: (entry) => entry.id !== "lane-b" }),
    );
    expect(model.edges.filter((edge) => edge.data?.edgeType === "topology").map((edge) => edge.id))
      .toEqual(["topology:primary:lane-a"]);
  });
});

describe("risk edges", () => {
  const riskByPair = new Map([
    [edgePairKey("lane-a", "lane-b"), { riskLevel: "high" as const, overlapCount: 3, stale: false }],
    [edgePairKey("primary", "lane-a"), { riskLevel: "none" as const, overlapCount: 0, stale: false }],
  ]);

  it("draws the overlap web in Conflict Risk and drops pairs with no overlap", () => {
    const model = buildGraphModel(input([PRIMARY, FLAT_A, FLAT_B], { viewMode: "risk", riskByPair }));
    const risk = model.edges.filter((edge) => edge.data?.edgeType === "risk");

    expect(risk.map((edge) => edge.id)).toEqual(["risk:lane-a:lane-b"]);
    expect(risk[0]!.data).toMatchObject({ riskLevel: "high", overlapCount: 3, stale: false });
  });

  it("draws it in Overview only while Show overlap web is on", () => {
    const off = buildGraphModel(input([PRIMARY, FLAT_A, FLAT_B], { viewMode: "all", riskByPair }));
    expect(off.edges.filter((edge) => edge.data?.edgeType === "risk")).toEqual([]);

    const on = buildGraphModel(
      input([PRIMARY, FLAT_A, FLAT_B], { viewMode: "all", riskByPair, showOverviewRiskEdges: true }),
    );
    expect(on.edges.filter((edge) => edge.data?.edgeType === "risk").map((edge) => edge.id))
      .toEqual(["risk:lane-a:lane-b"]);
  });

  it("gives a pair's PR badge to the risk edge rather than the stack edge", () => {
    const child = lane({ id: "lane-b", name: "beta", laneType: "attached", parentLaneId: "lane-a" });
    const pair = edgePairKey("lane-a", "lane-b");
    const prOverlayByPair = new Map([[pair, { prId: "pr-1", number: 7, laneId: "lane-b" }]]) as
      BuildGraphModelInput["prOverlayByPair"];

    const model = buildGraphModel(
      input([PRIMARY, FLAT_A, child], { viewMode: "risk", riskByPair, prOverlayByPair }),
    );
    const stackEdge = model.edges.find((edge) => edge.data?.edgeType === "stack");
    const riskEdge = model.edges.find((edge) => edge.data?.edgeType === "risk");

    expect(riskEdge?.data?.pr).toMatchObject({ number: 7 });
    expect(stackEdge?.data?.pr).toBeUndefined();
  });
});
