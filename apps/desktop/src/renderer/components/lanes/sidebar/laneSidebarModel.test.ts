import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import type { LaneAgent } from "../laneAgents";
import type { LaneTabPrTag } from "../lanePageModel";
import {
  LANE_ACTIVE_WINDOW_MS,
  LANE_STALE_AFTER_MS,
  buildLaneSidebarLayout,
  buildLaneSidebarRows,
  classifyLaneState,
  laneAgentToolType,
  laneGroupBulkActions,
  laneLastActivityAt,
  laneNeedsYouReason,
  laneSidebarAgentStatus,
  laneSidebarRange,
  laneSidebarVisibleLaneIds,
  laneStateGroupSectionId,
  stepLaneSidebarSelection,
  type LaneStateGroupId,
  type LaneStateInput,
} from "./laneSidebarModel";

function makeLane(overrides: Partial<LaneSummary> & { id: string }): LaneSummary {
  return {
    name: overrides.id,
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `feature/${overrides.id}`,
    worktreePath: `/tmp/${overrides.id}`,
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
    createdAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<LaneAgent>): LaneAgent {
  return {
    sessionId: "s1",
    laneId: "lane",
    kind: "chat",
    name: "Agent",
    modelId: null,
    providerLabel: "Claude",
    activity: "working",
    lastHint: null,
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildLaneSidebarRows", () => {
  const primary = makeLane({ id: "primary", laneType: "primary", createdAt: "2026-01-01T00:00:00.000Z" });

  it("puts primary first, top-level lanes newest first, and stacks under their parent", () => {
    const older = makeLane({ id: "older", parentLaneId: "primary", createdAt: "2026-09-01T00:00:00.000Z" });
    const newer = makeLane({ id: "newer", createdAt: "2026-09-10T00:00:00.000Z" });
    const childB = makeLane({ id: "child-b", parentLaneId: "older", createdAt: "2026-09-05T00:00:00.000Z" });
    const childA = makeLane({ id: "child-a", parentLaneId: "older", createdAt: "2026-09-03T00:00:00.000Z" });

    const rows = buildLaneSidebarRows([childB, newer, older, primary, childA]);

    expect(rows.map((row) => [row.lane.id, row.depth])).toEqual([
      ["primary", 0],
      ["newer", 0],
      ["older", 0],
      ["child-a", 1],
      ["child-b", 1],
    ]);
  });

  it("stops indenting after two levels so deep stacks keep their names in view", () => {
    const a = makeLane({ id: "a" });
    const b = makeLane({ id: "b", parentLaneId: "a" });
    const c = makeLane({ id: "c", parentLaneId: "b" });
    const d = makeLane({ id: "d", parentLaneId: "c" });

    const rows = buildLaneSidebarRows([primary, a, b, c, d]);

    expect(rows.map((row) => [row.lane.id, row.depth, row.indentLevel])).toEqual([
      ["primary", 0, 0],
      ["a", 0, 0],
      ["b", 1, 1],
      ["c", 2, 2],
      ["d", 3, 2],
    ]);
  });

  it("promotes a lane whose parent is filtered out, and survives a parent cycle", () => {
    const orphan = makeLane({ id: "orphan", parentLaneId: "missing" });
    const loopA = makeLane({ id: "loop-a", parentLaneId: "loop-b" });
    const loopB = makeLane({ id: "loop-b", parentLaneId: "loop-a" });

    const rows = buildLaneSidebarRows([orphan, loopA, loopB]);

    expect(rows.map((row) => row.lane.id).sort()).toEqual(["loop-a", "loop-b", "orphan"]);
    expect(rows.find((row) => row.lane.id === "orphan")?.depth).toBe(0);
  });
});

describe("sidebar selection helpers", () => {
  it("steps and wraps through the list", () => {
    const ids = ["a", "b", "c"];
    expect(stepLaneSidebarSelection(ids, "a", 1)).toBe("b");
    expect(stepLaneSidebarSelection(ids, "c", 1)).toBe("a");
    expect(stepLaneSidebarSelection(ids, "a", -1)).toBe("c");
    expect(stepLaneSidebarSelection(ids, null, -1)).toBe("c");
    expect(stepLaneSidebarSelection([], "a", 1)).toBeNull();
  });

  it("selects a range in row order from either direction", () => {
    const ids = ["a", "b", "c", "d"];
    expect(laneSidebarRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(laneSidebarRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(laneSidebarRange(ids, null, "c")).toEqual(["c"]);
  });
});

describe("laneSidebarAgentStatus", () => {
  it("is empty when nothing runs in the lane", () => {
    expect(laneSidebarAgentStatus([makeAgent({ activity: "idle" })], null)).toBeNull();
  });

  it("shows working agents", () => {
    const status = laneSidebarAgentStatus([makeAgent({ activity: "working" })], null);
    expect(status?.tone).toBe("working");
    expect(status?.agents).toHaveLength(1);
  });

  it("puts an agent waiting on the user first and flags the lane", () => {
    const status = laneSidebarAgentStatus(
      [
        makeAgent({ sessionId: "busy", activity: "working" }),
        makeAgent({ sessionId: "asking", activity: "awaiting-input" }),
      ],
      null,
    );
    expect(status?.tone).toBe("attention");
    expect(status?.agents.map((agent) => agent.sessionId)).toEqual(["asking", "busy"]);
  });

  it("flags a terminal waiting for input even without a known agent", () => {
    const status = laneSidebarAgentStatus([], {
      bucket: "awaiting-input",
      runningCount: 0,
      awaitingInputCount: 1,
    });
    expect(status?.tone).toBe("attention");
    expect(status?.agents).toEqual([]);
  });
});

describe("row metadata", () => {
  it("maps provider labels to logo tool types", () => {
    expect(laneAgentToolType({ providerLabel: "Claude" })).toBe("claude");
    expect(laneAgentToolType({ providerLabel: "OpenCode" })).toBe("opencode");
    expect(laneAgentToolType({ providerLabel: "CLI" })).toBeNull();
  });

  it("uses the newest of last commit and agent activity", () => {
    const lane = makeLane({ id: "a", status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false, lastCommitAt: "2026-09-02T00:00:00.000Z" } });
    expect(laneLastActivityAt(lane, [])).toBe("2026-09-02T00:00:00.000Z");
    expect(laneLastActivityAt(lane, [makeAgent({ lastActivityAt: "2026-09-05T00:00:00.000Z" })])).toBe("2026-09-05T00:00:00.000Z");
    expect(laneLastActivityAt(makeLane({ id: "b" }), [])).toBeNull();
  });
});

describe("classifyLaneState", () => {
  const NOW = Date.parse("2026-09-24T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
  const daysAgo = (days: number) => hoursAgo(days * 24);

  function makePr(overrides: Partial<LaneTabPrTag> = {}): LaneTabPrTag {
    return {
      source: "ade",
      id: "pr",
      linkedPrId: "pr",
      githubPrNumber: 1301,
      githubUrl: "https://github.com/acme/ade/pull/1301",
      repoOwner: "acme",
      repoName: "ade",
      title: "PR",
      state: "open",
      updatedAt: hoursAgo(3),
      ...overrides,
    };
  }

  /** A lane last touched 3 days ago, not behind, no PR, no agents: Quiet. */
  function input(overrides: Partial<LaneStateInput> & { lastCommitAt?: string; behind?: number } = {}): LaneStateInput {
    const { lastCommitAt = daysAgo(3), behind = 0, ...rest } = overrides;
    return {
      lane: makeLane({
        id: "lane",
        createdAt: daysAgo(20),
        status: { dirty: false, ahead: 1, behind, remoteBehind: -1, rebaseInProgress: false, lastCommitAt },
      }),
      agents: [],
      runtime: null,
      prs: undefined,
      rebaseSuggestion: null,
      autoRebaseStatus: null,
      nowMs: NOW,
      ...rest,
    };
  }

  it("pins Primary no matter what it carries", () => {
    const primary = input({
      lane: makeLane({ id: "p", laneType: "primary", createdAt: daysAgo(90) }),
      prs: [makePr({ state: "merged" })],
      agents: [makeAgent({ activity: "awaiting-input" })],
    });
    expect(classifyLaneState(primary)).toBe("primary");
    expect(laneNeedsYouReason(primary)).toBeNull();
  });

  it("puts a lane in Needs you for each attention signal", () => {
    const cases: Array<[Partial<LaneStateInput>, string]> = [
      [{ agents: [makeAgent({ activity: "awaiting-input" })] }, "An agent is waiting for you"],
      [{ runtime: { bucket: "running", runningCount: 1, awaitingInputCount: 1 } }, "An agent is waiting for you"],
      [{ prs: [makePr({ checksStatus: "failing" })] }, "PR checks are failing"],
      [{ prs: [makePr({ reviewStatus: "changes_requested" })] }, "PR has changes requested"],
      [{ prs: [makePr({ state: "draft", mergeConflicts: true })] }, "PR has merge conflicts"],
      [{ autoRebaseStatus: { state: "rebaseConflict" } }, "Rebase hit conflicts"],
      [{ autoRebaseStatus: { state: "rebaseFailed" } }, "Rebase failed"],
    ];
    for (const [overrides, reason] of cases) {
      expect(classifyLaneState(input(overrides))).toBe("needs-you");
      expect(laneNeedsYouReason(input(overrides))).toBe(reason);
    }
  });

  it("ignores trouble on merged PRs and on PRs from an earlier branch", () => {
    expect(classifyLaneState(input({ prs: [makePr({ state: "merged", checksStatus: "failing" })] }))).toBe("done");
    expect(classifyLaneState(input({ prs: [makePr({ laneRole: "previous", checksStatus: "failing" })] }))).toBe("quiet");
  });

  it("is Active while an agent works, or right after recent activity", () => {
    expect(classifyLaneState(input({ agents: [makeAgent({ activity: "working", lastActivityAt: daysAgo(2) })] }))).toBe("active");
    expect(classifyLaneState(input({ agents: [makeAgent({ activity: "monitoring", lastActivityAt: daysAgo(2) })] }))).toBe("active");
    expect(classifyLaneState(input({ runtime: { bucket: "running", runningCount: 1, awaitingInputCount: 0 } }))).toBe("active");
    expect(classifyLaneState(input({ lastCommitAt: hoursAgo(1) }))).toBe("active");
    // An idle chat that spoke recently still counts as recent activity.
    expect(classifyLaneState(input({ agents: [makeAgent({ activity: "idle", lastActivityAt: hoursAgo(1) })] }))).toBe("active");
    expect(classifyLaneState(input({ lastCommitAt: new Date(NOW - LANE_ACTIVE_WINDOW_MS - 60_000).toISOString() }))).toBe("quiet");
  });

  it("is Behind main when behind its base or a rebase is suggested", () => {
    expect(classifyLaneState(input({ behind: 4 }))).toBe("behind");
    expect(classifyLaneState(input({ rebaseSuggestion: { behindCount: 2 } }))).toBe("behind");
  });

  it("is Done when the current PR merged, even if behind", () => {
    expect(classifyLaneState(input({ behind: 6, prs: [makePr({ state: "merged" })] }))).toBe("done");
    // A newer open PR on the same lane is the live work, not the merged one.
    expect(classifyLaneState(input({
      prs: [makePr({ state: "merged", githubPrNumber: 1200 }), makePr({ id: "pr2", githubPrNumber: 1302, state: "open" })],
    }))).toBe("quiet");
  });

  it("is Stale only past the threshold, with no open PR and no live agent", () => {
    const justOver = new Date(NOW - LANE_STALE_AFTER_MS - 60_000).toISOString();
    const justUnder = new Date(NOW - LANE_STALE_AFTER_MS + 60_000).toISOString();
    const old = (lastCommitAt: string) => input({ lastCommitAt, lane: makeLane({ id: "lane", createdAt: daysAgo(60), status: { dirty: false, ahead: 1, behind: 0, remoteBehind: -1, rebaseInProgress: false, lastCommitAt } }) });
    expect(classifyLaneState(old(justOver))).toBe("stale");
    expect(classifyLaneState(old(justUnder))).toBe("quiet");
    expect(classifyLaneState({ ...old(justOver), prs: [makePr({ state: "draft" })] })).toBe("quiet");
    // A freshly created lane with no commits yet is not stale.
    expect(classifyLaneState(input({ lastCommitAt: daysAgo(40), lane: makeLane({ id: "lane", createdAt: daysAgo(1) }) }))).toBe("quiet");
  });

  it("takes the first match in group order", () => {
    // Waiting agent beats working agent, behind, and merged.
    expect(classifyLaneState(input({
      behind: 3,
      prs: [makePr({ state: "merged" })],
      agents: [makeAgent({ activity: "working" }), makeAgent({ sessionId: "s2", activity: "awaiting-input" })],
    }))).toBe("needs-you");
    // A working agent beats behind.
    expect(classifyLaneState(input({ behind: 3, agents: [makeAgent({ activity: "working" })] }))).toBe("active");
    // Behind beats stale.
    expect(classifyLaneState(input({ behind: 3, lastCommitAt: daysAgo(40) }))).toBe("behind");
  });
});

describe("buildLaneSidebarLayout", () => {
  const primary = makeLane({ id: "primary", laneType: "primary", createdAt: "2026-01-01T00:00:00.000Z" });
  const parent = makeLane({ id: "parent", parentLaneId: "primary", createdAt: "2026-09-01T00:00:00.000Z" });
  const sameGroupChild = makeLane({ id: "same", parentLaneId: "parent", createdAt: "2026-09-02T00:00:00.000Z" });
  const otherGroupChild = makeLane({ id: "other", name: "Other", parentLaneId: "parent", createdAt: "2026-09-03T00:00:00.000Z" });
  const done = makeLane({ id: "done", createdAt: "2026-09-04T00:00:00.000Z" });
  const lanes = [primary, parent, sameGroupChild, otherGroupChild, done];
  const lanesById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const stateByLaneId = new Map<string, LaneStateGroupId | "primary">([
    ["primary", "primary"],
    ["parent", "behind"],
    ["same", "behind"],
    ["other", "active"],
    ["done", "done"],
  ]);

  it("pins Primary, orders groups, hides empty ones, and hints split stacks", () => {
    const layout = buildLaneSidebarLayout({ lanes, groupBy: "state", stateByLaneId, lanesById });
    if (layout.groupBy !== "state") throw new Error("expected state layout");
    expect(layout.pinned.map((row) => row.lane.id)).toEqual(["primary"]);
    expect(layout.groups.map((group) => group.id)).toEqual(["active", "behind", "done"]);
    const behind = layout.groups.find((group) => group.id === "behind")!;
    expect(behind.rows.map((row) => [row.lane.id, row.depth, row.parentHint ?? null])).toEqual([
      ["parent", 0, null],
      ["same", 1, null],
    ]);
    const active = layout.groups.find((group) => group.id === "active")!;
    expect(active.rows.map((row) => [row.lane.id, row.depth, row.parentHint])).toEqual([["other", 0, "parent"]]);
  });

  it("walks visible rows in screen order and skips collapsed groups", () => {
    const layout = buildLaneSidebarLayout({ lanes, groupBy: "state", stateByLaneId, lanesById });
    expect(laneSidebarVisibleLaneIds(layout, new Set())).toEqual(["primary", "other", "parent", "same", "done"]);
    expect(laneSidebarVisibleLaneIds(layout, new Set([laneStateGroupSectionId("behind")]))).toEqual(["primary", "other", "done"]);
  });

  it("falls back to the plain stack tree", () => {
    const layout = buildLaneSidebarLayout({ lanes, groupBy: "stack", stateByLaneId, lanesById });
    expect(laneSidebarVisibleLaneIds(layout, new Set([laneStateGroupSectionId("behind")]))).toEqual(
      buildLaneSidebarRows(lanes).map((row) => row.lane.id),
    );
  });

  it("offers bulk actions only on Done, Behind main and Stale", () => {
    expect(laneGroupBulkActions("done")).toEqual(["archive"]);
    expect(laneGroupBulkActions("behind")).toEqual(["rebase"]);
    expect(laneGroupBulkActions("stale")).toEqual(["archive", "delete"]);
    expect(laneGroupBulkActions("needs-you")).toEqual([]);
    expect(laneGroupBulkActions("active")).toEqual([]);
    expect(laneGroupBulkActions("quiet")).toEqual([]);
  });
});
