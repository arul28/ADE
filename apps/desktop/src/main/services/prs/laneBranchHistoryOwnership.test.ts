import { describe, expect, it } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import {
  buildLaneBranchHistoryIndex,
  pickLaneBranchHistoryPr,
  prOpenedDuringLane,
  resolveLaneBranchHistoryOwner,
} from "./laneBranchHistoryOwnership";

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "follow-up work",
    laneType: "worktree",
    branchRef: "refs/heads/my-feature",
    baseRef: "refs/heads/main",
    createdAt: "2026-01-01T00:00:00Z",
    archivedAt: null,
    ...overrides,
  } as LaneSummary;
}

describe("buildLaneBranchHistoryIndex", () => {
  it("groups lane ids by normalized branch name", () => {
    const index = buildLaneBranchHistoryIndex([
      { laneId: "lane-1", branchRef: "refs/heads/feature/follow-up" },
      { laneId: "lane-2", branchRef: "refs/heads/feature/follow-up" },
      { laneId: "lane-1", branchRef: "refs/heads/feature/other" },
    ]);

    expect([...(index.get("feature/follow-up") ?? [])].sort()).toEqual(["lane-1", "lane-2"]);
    expect([...(index.get("feature/other") ?? [])]).toEqual(["lane-1"]);
  });
});

describe("resolveLaneBranchHistoryOwner", () => {
  const followUp = "feature/follow-up";

  it("returns the single worktree lane whose history used the branch", () => {
    const owner = resolveLaneBranchHistoryOwner(
      followUp,
      [lane()],
      buildLaneBranchHistoryIndex([{ laneId: "lane-1", branchRef: followUp }]),
    );

    expect(owner?.id).toBe("lane-1");
  });

  it("returns null when a lane records the branch as its own", () => {
    // The strict branch match owns that case; history must not double-claim it.
    const owner = resolveLaneBranchHistoryOwner(
      followUp,
      [lane({ branchRef: `refs/heads/${followUp}` })],
      buildLaneBranchHistoryIndex([{ laneId: "lane-1", branchRef: followUp }]),
    );

    expect(owner).toBeNull();
  });

  it("returns null when more than one lane used the branch", () => {
    const owner = resolveLaneBranchHistoryOwner(
      followUp,
      [lane(), lane({ id: "lane-2" })],
      buildLaneBranchHistoryIndex([
        { laneId: "lane-1", branchRef: followUp },
        { laneId: "lane-2", branchRef: followUp },
      ]),
    );

    expect(owner).toBeNull();
  });

  it("returns null when no lane used the branch", () => {
    expect(resolveLaneBranchHistoryOwner(followUp, [lane()], new Map())).toBeNull();
  });

  it.each([
    { name: "archived", overrides: { archivedAt: "2026-02-01T00:00:00Z" } },
    { name: "the primary lane", overrides: { laneType: "primary" as const } },
  ])("returns null for a $name owner", ({ overrides }) => {
    const owner = resolveLaneBranchHistoryOwner(
      followUp,
      [lane(overrides)],
      buildLaneBranchHistoryIndex([{ laneId: "lane-1", branchRef: followUp }]),
    );

    expect(owner).toBeNull();
  });
});

describe("prOpenedDuringLane", () => {
  const owner = lane({ createdAt: "2026-01-01T00:00:00Z" });

  it("accepts a PR created after the lane", () => {
    expect(prOpenedDuringLane("2026-01-02T00:00:00Z", owner)).toBe(true);
  });

  it("accepts a PR created within the clock-skew window before the lane", () => {
    expect(prOpenedDuringLane("2025-12-31T23:57:00Z", owner)).toBe(true);
  });

  it("rejects a PR created well before the lane", () => {
    // A reused branch name carries PRs from before the lane existed.
    expect(prOpenedDuringLane("2025-12-30T00:00:00Z", owner)).toBe(false);
  });

  it("rejects an unparseable created_at rather than guessing", () => {
    expect(prOpenedDuringLane(null, owner)).toBe(false);
    expect(prOpenedDuringLane("not-a-date", owner)).toBe(false);
  });
});

describe("pickLaneBranchHistoryPr", () => {
  it("prefers an open PR over a merged one regardless of number", () => {
    const picked = pickLaneBranchHistoryPr([
      { prNumber: 900, isOpen: false },
      { prNumber: 12, isOpen: true },
    ]);

    expect(picked).toEqual({ prNumber: 12, isOpen: true });
  });

  it("picks the newest number among PRs of the same openness", () => {
    const picked = pickLaneBranchHistoryPr([
      { prNumber: 10, isOpen: false },
      { prNumber: 30, isOpen: false },
      { prNumber: 20, isOpen: false },
    ]);

    expect(picked).toEqual({ prNumber: 30, isOpen: false });
  });

  it("returns null for no candidates", () => {
    expect(pickLaneBranchHistoryPr([])).toBeNull();
  });
});
