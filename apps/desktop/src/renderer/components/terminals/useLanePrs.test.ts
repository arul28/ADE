import { describe, expect, it } from "vitest";
import type { GitHubPrListItem, LaneSummary, PrSummary } from "../../../shared/types";
import {
  boundMachineLanePrs,
  buildLanePrsByLaneId,
  laneAnyMachineKey,
  laneBoundMachineKey,
  laneHasAnyPr,
  lanePrCompositeKey,
  lanePrsForMachine,
} from "./useLanePrs";

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Stack UI",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/stack-ui",
    worktreePath: "/repo/.ade/worktrees/stack-ui",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    status: null,
    parentStatus: null,
    isEditProtected: false,
    createdAt: "2026-07-30T12:00:00Z",
    archivedAt: null,
    ...overrides,
  } as LaneSummary;
}

function mappedPr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-91",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 91,
    githubUrl: "https://github.com/arul28/ADE/pull/91",
    githubNodeId: null,
    title: "Stack UI",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/stack-ui",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 10,
    deletions: 2,
    lastSyncedAt: "2026-07-30T12:00:00Z",
    createdAt: "2026-07-30T11:00:00Z",
    updatedAt: "2026-07-30T12:00:00Z",
    ...overrides,
  };
}

function githubPr(overrides: Partial<GitHubPrListItem> = {}): GitHubPrListItem {
  return {
    id: "github-pr-91",
    scope: "repo",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 91,
    githubUrl: "https://github.com/arul28/ADE/pull/91",
    title: "Stack UI",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "feature/stack-ui",
    author: "arul28",
    createdAt: "2026-07-30T11:00:00Z",
    updatedAt: "2026-07-30T12:00:00Z",
    linkedPrId: null,
    linkedGroupId: null,
    linkedLaneId: null,
    linkedLaneName: null,
    adeKind: null,
    ...overrides,
  } as GitHubPrListItem;
}

describe("buildLanePrsByLaneId", () => {
  it("uses a single GitHub snapshot to surface an unmapped branch PR in Work", () => {
    const result = buildLanePrsByLaneId({
      lanes: [lane()],
      prs: [],
      githubPrs: [githubPr({
        stack: {
          id: "stack-18",
          number: 18,
          size: 3,
          position: 2,
          baseBranch: "main",
        },
      })],
    });

    expect(result.get("lane-1")).toEqual([
      expect.objectContaining({
        id: "gh:arul28/ADE#91",
        laneId: "lane-1",
        githubPrNumber: 91,
        unmapped: true,
        stack: expect.objectContaining({ number: 18, position: 2, size: 3 }),
      }),
    ]);
  });

  it("keeps the mapped summary while accepting fresher stack membership", () => {
    const result = buildLanePrsByLaneId({
      lanes: [lane()],
      prs: [mappedPr()],
      githubPrs: [githubPr({
        linkedPrId: "pr-91",
        linkedLaneId: "lane-1",
        stack: {
          id: "stack-18",
          number: 18,
          size: 3,
          position: 2,
          baseBranch: "main",
        },
      })],
    });

    expect(result.get("lane-1")?.[0]).toEqual(expect.objectContaining({
      id: "pr-91",
      checksStatus: "passing",
      stack: expect.objectContaining({ number: 18, position: 2, size: 3 }),
    }));
  });

  it("keeps a new GitHub-only PR visible alongside retained lane history", () => {
    const result = buildLanePrsByLaneId({
      lanes: [lane()],
      prs: [mappedPr({ headBranch: "feature/old" })],
      githubPrs: [githubPr({
        id: "github-pr-92",
        githubPrNumber: 92,
        githubUrl: "https://github.com/arul28/ADE/pull/92",
        title: "Follow-up work",
      })],
    });

    expect(result.get("lane-1")?.map((pr) => pr.githubPrNumber)).toEqual([91, 92]);
    expect(result.get("lane-1")?.find((pr) => pr.githubPrNumber === 92)?.unmapped).toBe(true);
  });

  it("retains mapped rows from an old lane branch as history", () => {
    const result = buildLanePrsByLaneId({
      lanes: [lane()],
      prs: [mappedPr({ headBranch: "feature/old" })],
      githubPrs: [],
    });

    expect(result.get("lane-1")?.map((pr) => pr.githubPrNumber)).toEqual([91]);
  });
});

/*
 * Key discipline. These pin the invariant that made a remote machine's PRs
 * invisible: a lookup has to name the machine, because a lane id does not.
 */
describe("lane PR key namespaces", () => {
  it("never collides across the three namespaces for one lane id", () => {
    const keys = [
      lanePrCompositeKey("machine-a", "lane-1"),
      laneBoundMachineKey("lane-1"),
      laneAnyMachineKey("lane-1"),
    ];

    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain("lane-1");
    expect(lanePrCompositeKey("machine-a", "lane-1"))
      .not.toBe(lanePrCompositeKey("machine-b", "lane-1"));
  });

  // The regression: cross-machine handoff copies a lane id, so a foreign
  // machine's PR could answer a bound-machine lookup and render a badge that
  // deep-links into a PRs tab which cannot resolve it.
  it("keeps a foreign machine's PR out of the bound machine's answer", () => {
    const byLane = new Map<string, PrSummary[]>([
      [lanePrCompositeKey("machine-b", "lane-1"), [mappedPr({ id: "pr-foreign" })]],
      [laneAnyMachineKey("lane-1"), [mappedPr({ id: "pr-foreign" })]],
    ]);

    expect(boundMachineLanePrs(byLane, "lane-1")).toEqual([]);
    expect(lanePrsForMachine(byLane, "machine-b", "lane-1")[0]?.id).toBe("pr-foreign");
    expect(lanePrsForMachine(byLane, "machine-a", "lane-1")).toEqual([]);
  });

  it("answers the filter chip from any machine, including a foreign-only lane", () => {
    const byLane = new Map<string, PrSummary[]>([
      [lanePrCompositeKey("machine-b", "lane-1"), [mappedPr()]],
      [laneAnyMachineKey("lane-1"), [mappedPr()]],
    ]);

    expect(laneHasAnyPr(byLane, "lane-1")).toBe(true);
    expect(laneHasAnyPr(byLane, "lane-unknown")).toBe(false);
    expect(boundMachineLanePrs(byLane, "lane-unknown")).toEqual([]);
  });
});
