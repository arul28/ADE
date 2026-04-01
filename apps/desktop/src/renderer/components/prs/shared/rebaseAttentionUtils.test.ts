import { describe, expect, it } from "vitest";
import type { AutoRebaseLaneStatus, LaneSummary, RebaseNeed } from "../../../../shared/types";
import {
  buildRebaseAttentionItems,
  filterRebaseAttentionStatuses,
  findRebaseAttentionStatus,
  formatRebaseAttentionSummary,
} from "./rebaseAttentionUtils";

function makeNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: overrides.laneId ?? "lane-1",
    laneName: overrides.laneName ?? "Lane 1",
    kind: overrides.kind ?? "lane_base",
    baseBranch: overrides.baseBranch ?? "main",
    behindBy: overrides.behindBy ?? 1,
    conflictPredicted: overrides.conflictPredicted ?? false,
    conflictingFiles: overrides.conflictingFiles ?? [],
    prId: overrides.prId ?? null,
    groupContext: overrides.groupContext ?? null,
    dismissedAt: overrides.dismissedAt ?? null,
    deferredUntil: overrides.deferredUntil ?? null,
  };
}

function makeStatus(overrides: Partial<AutoRebaseLaneStatus> = {}): AutoRebaseLaneStatus {
  return {
    laneId: overrides.laneId ?? "lane-1",
    parentLaneId: overrides.parentLaneId ?? "lane-parent",
    parentHeadSha: overrides.parentHeadSha ?? "abc123",
    state: overrides.state ?? "rebasePending",
    updatedAt: overrides.updatedAt ?? "2026-04-01T12:00:00.000Z",
    conflictCount: overrides.conflictCount ?? 0,
    message: overrides.message ?? "Waiting on ancestor lane.",
  };
}

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: overrides.id ?? "lane-1",
    name: overrides.name ?? "Lane 1",
    description: overrides.description ?? null,
    laneType: overrides.laneType ?? "worktree",
    baseRef: overrides.baseRef ?? "refs/heads/main",
    branchRef: overrides.branchRef ?? "refs/heads/lane-1",
    worktreePath: overrides.worktreePath ?? "/tmp/lane-1",
    attachedRootPath: overrides.attachedRootPath ?? null,
    parentLaneId: overrides.parentLaneId ?? "lane-parent",
    childCount: overrides.childCount ?? 0,
    stackDepth: overrides.stackDepth ?? 1,
    parentStatus: overrides.parentStatus ?? null,
    isEditProtected: overrides.isEditProtected ?? false,
    status: overrides.status ?? {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: overrides.color ?? null,
    icon: overrides.icon ?? null,
    tags: overrides.tags ?? [],
    folder: overrides.folder ?? null,
    missionId: overrides.missionId ?? null,
    laneRole: overrides.laneRole ?? null,
    createdAt: overrides.createdAt ?? "2026-04-01T11:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
  };
}

describe("filterRebaseAttentionStatuses", () => {
  it("keeps active chain attention when the lane has no visible direct need", () => {
    const statuses = [
      makeStatus({ laneId: "grandchild", state: "rebasePending" }),
    ];

    expect(
      filterRebaseAttentionStatuses({
        autoRebaseStatuses: statuses,
        visibleRebaseNeeds: [],
        view: "active",
      }),
    ).toEqual(statuses);
  });

  it("hides attention statuses when the same lane already has a visible direct need", () => {
    const statuses = [
      makeStatus({ laneId: "child", state: "rebaseConflict" }),
    ];
    const needs = [
      makeNeed({ laneId: "child", kind: "lane_base", baseBranch: "feature/parent" }),
    ];

    expect(
      filterRebaseAttentionStatuses({
        autoRebaseStatuses: statuses,
        visibleRebaseNeeds: needs,
        view: "active",
      }),
    ).toEqual([]);
  });

  it("sorts active statuses by severity before recency", () => {
    const pending = makeStatus({ laneId: "pending", state: "rebasePending", updatedAt: "2026-04-01T12:00:00.000Z" });
    const failed = makeStatus({ laneId: "failed", state: "rebaseFailed", updatedAt: "2026-04-01T11:00:00.000Z" });
    const conflict = makeStatus({ laneId: "conflict", state: "rebaseConflict", updatedAt: "2026-04-01T10:00:00.000Z" });

    expect(
      filterRebaseAttentionStatuses({
        autoRebaseStatuses: [pending, failed, conflict],
        visibleRebaseNeeds: [],
        view: "active",
      }).map((status) => status.laneId),
    ).toEqual(["conflict", "failed", "pending"]);
  });

  it("keeps auto-rebased statuses only in history view", () => {
    const statuses = [
      makeStatus({ laneId: "recent", state: "autoRebased" }),
      makeStatus({ laneId: "pending", state: "rebasePending" }),
    ];

    expect(
      filterRebaseAttentionStatuses({
        autoRebaseStatuses: statuses,
        visibleRebaseNeeds: [],
        view: "history",
      }).map((status) => status.laneId),
    ).toEqual(["recent"]);
  });
});

describe("findRebaseAttentionStatus", () => {
  it("matches raw lane ids used for attention-only selections", () => {
    const status = makeStatus({ laneId: "lane-grandchild" });
    expect(findRebaseAttentionStatus([status], "lane-grandchild")).toEqual(status);
  });

  it("matches prefixed attention selections", () => {
    const status = makeStatus({ laneId: "lane-grandchild" });
    expect(findRebaseAttentionStatus([status], "attention:lane-grandchild")).toEqual(status);
  });

  it("returns null when the selected item id is empty", () => {
    expect(findRebaseAttentionStatus([], "   ")).toBeNull();
  });
});

describe("buildRebaseAttentionItems", () => {
  it("surfaces chain attention with parent trail context while excluding direct needs", () => {
    const lanes = [
      makeLane({ id: "root", name: "Root", parentLaneId: null, stackDepth: 0 }),
      makeLane({ id: "parent", name: "Parent", parentLaneId: "root", stackDepth: 1 }),
      makeLane({ id: "child", name: "Child", parentLaneId: "parent", stackDepth: 2 }),
    ];
    const items = buildRebaseAttentionItems({
      autoRebaseStatuses: [
        makeStatus({ laneId: "child", parentLaneId: "parent", state: "rebasePending" }),
      ],
      lanes,
      visibleRebaseNeeds: [],
      view: "active",
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.chainTrail).toEqual(["Root", "Parent", "Child"]);
    expect(items[0]?.parentLaneName).toBe("Parent");
    expect(formatRebaseAttentionSummary(items[0]!)).toContain("waiting for Parent");
  });

  it("hides attention items when the same lane already has a visible direct need", () => {
    const lanes = [makeLane({ id: "child", name: "Child", parentLaneId: "parent" })];
    expect(
      buildRebaseAttentionItems({
        autoRebaseStatuses: [makeStatus({ laneId: "child", parentLaneId: "parent", state: "rebaseConflict" })],
        lanes,
        visibleRebaseNeeds: [makeNeed({ laneId: "child", kind: "lane_base" })],
        view: "active",
      }),
    ).toEqual([]);
  });
});
