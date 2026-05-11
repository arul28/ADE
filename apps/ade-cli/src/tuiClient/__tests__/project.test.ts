import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseInitialLane } from "../project";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function lane(overrides: Partial<LaneSummary>): LaneSummary {
  return {
    id: "main",
    name: "main",
    laneType: "primary",
    baseRef: "main",
    branchRef: "main",
    worktreePath: "/repo",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("chooseInitialLane", () => {
  it("prefers the ADE worktree lane hint", () => {
    const lanes = [
      lane({ id: "main", name: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-a", name: "Feature A", laneType: "worktree", branchRef: "feature/a", worktreePath: "/repo/.ade/worktrees/feature-a" }),
    ];
    expect(chooseInitialLane(lanes, {
      workspaceRoot: "/repo/.ade/worktrees/feature-a",
      laneHint: "feature-a",
    })?.id).toBe("feature-a");
  });

  it("falls back to matching the workspace path", () => {
    const worktreePath = path.resolve("/repo/.ade/worktrees/feature-b");
    const lanes = [
      lane({ id: "main", laneType: "primary", worktreePath: "/repo" }),
      lane({ id: "feature-b", laneType: "worktree", worktreePath }),
    ];
    expect(chooseInitialLane(lanes, {
      workspaceRoot: path.join(worktreePath, "apps/desktop"),
      laneHint: null,
    })?.id).toBe("feature-b");
  });
});
