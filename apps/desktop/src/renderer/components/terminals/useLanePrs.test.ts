import { describe, expect, it } from "vitest";
import type { GitHubPrListItem, LaneSummary, PrSummary } from "../../../shared/types";
import { buildLanePrsByLaneId } from "./useLanePrs";

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

  it("ignores stale mapped rows from an old lane branch", () => {
    const result = buildLanePrsByLaneId({
      lanes: [lane()],
      prs: [mappedPr({ headBranch: "feature/old" })],
      githubPrs: [],
    });

    expect(result.has("lane-1")).toBe(false);
  });
});
