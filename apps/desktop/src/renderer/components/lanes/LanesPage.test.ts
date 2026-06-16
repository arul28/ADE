import { describe, expect, it } from "vitest";
import {
  buildLaneActionClearedSearch,
  getDeferredLanePaneDelayMs,
  githubPrMatchesCurrentBranch,
  laneHasAncestor,
  lanePrMatchesCurrentBranch,
  planLaneDeleteBatches,
  resolveLaneDeleteStartSelection,
  resolveCreateLaneRequest,
  resolveLaneIdsDeepLinkSelection,
  resolveVisibleLaneIds,
  runLaneDeleteBatchWithConcurrency,
  selectGithubLanePrTag,
  selectLaneTabPrTag,
  selectLanePrTag,
  selectVisibleLanePrRefreshIds,
  shouldApplyLaneIdsDeepLink,
  sortLaneListRows,
} from "./lanePageModel";
import { buildLaneSplitColumnsKey, shouldMountGitActionsPane } from "./LanesPage";
import type {
  GitHubPrListItem,
  LaneSummary,
  PrSummary,
} from "../../../shared/types";

type LanePrTarget = Pick<LaneSummary, "id" | "laneType" | "branchRef" | "baseRef">;

function makeLane(overrides: Partial<LanePrTarget> = {}): LanePrTarget {
  return {
    id: "lane-1",
    laneType: "worktree",
    branchRef: "ade/pr-state",
    baseRef: "main",
    ...overrides,
  };
}

function makePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 224,
    githubUrl: "https://github.com/arul28/ADE/pull/224",
    githubNodeId: "PR_node224",
    title: "Show merged PR state",
    state: "open",
    baseBranch: "main",
    headBranch: "origin/ade/pr-state",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 1,
    lastSyncedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeGitHubPr(overrides: Partial<GitHubPrListItem> = {}): GitHubPrListItem {
  return {
    id: "repo-pr-224",
    scope: "repo",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 224,
    githubUrl: "https://github.com/arul28/ADE/pull/224",
    title: "Show merged PR state",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "origin/ade/pr-state",
    author: "arul",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    linkedPrId: null,
    linkedGroupId: null,
    linkedLaneId: null,
    linkedLaneName: null,
    adeKind: null,
    workflowDisplayState: null,
    cleanupState: null,
    labels: [],
    isBot: false,
    commentCount: 0,
    ...overrides,
  };
}

describe("resolveCreateLaneRequest", () => {
  it("creates an independent lane from the selected primary branch", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createMode: "primary",
        createParentLaneId: "lane-primary",
        createBaseBranch: "main",
        createImportBranch: "",
      }),
    ).toEqual({
      kind: "root",
      args: {
        name: "git actions fixes",
        baseBranch: "main",
      },
    });
  });

  it("creates a stacked child lane when child mode is selected", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createMode: "child",
        createParentLaneId: "lane-primary",
        createBaseBranch: "main",
        createImportBranch: "",
      }),
    ).toEqual({
      kind: "child",
      args: {
        name: "git actions fixes",
        parentLaneId: "lane-primary",
      },
    });
  });

  it("imports an existing branch as a lane when existing mode is selected", () => {
    expect(
      resolveCreateLaneRequest({
        name: "git actions fixes",
        createMode: "existing",
        createParentLaneId: "",
        createBaseBranch: "release-10",
        createImportBranch: "origin/ade/git-actions-fixes-5144fe89",
      }),
    ).toEqual({
      kind: "import",
      args: {
        branchRef: "origin/ade/git-actions-fixes-5144fe89",
        name: "git actions fixes",
      },
    });
  });
});

describe("resolveLaneIdsDeepLinkSelection", () => {
  it("returns the lane selection for a new deep link signature", () => {
    expect(resolveLaneIdsDeepLinkSelection({
      laneIdsRaw: "lane-a, lane-b",
      inspectorTabParam: "work",
      availableLaneIds: ["lane-a", "lane-b", "lane-c"],
      consumedSignature: null,
    })).toEqual({
      laneIds: ["lane-a", "lane-b"],
      signature: "lane-a,lane-b::work",
    });
  });

  it("does not re-apply the same laneIds deep link after it has been consumed", () => {
    expect(resolveLaneIdsDeepLinkSelection({
      laneIdsRaw: "lane-a,lane-b",
      inspectorTabParam: "work",
      availableLaneIds: ["lane-a", "lane-b"],
      consumedSignature: "lane-a,lane-b::work",
    })).toBeNull();
  });

  it("waits for referenced lanes to exist before consuming the deep link", () => {
    expect(resolveLaneIdsDeepLinkSelection({
      laneIdsRaw: "lane-a,lane-b",
      inspectorTabParam: "work",
      availableLaneIds: ["lane-a"],
      consumedSignature: null,
    })).toBeNull();
  });

  it("does not apply laneIds while an action deep link is being handled", () => {
    expect(shouldApplyLaneIdsDeepLink({
      action: "batch",
      laneIdsRaw: "lane-a,lane-b",
    })).toBe(false);
  });

  it("applies laneIds when no action deep link is present", () => {
    expect(shouldApplyLaneIdsDeepLink({
      action: null,
      laneIdsRaw: "lane-a,lane-b",
    })).toBe(true);
  });

  it("scrubs action lane params while preserving unrelated query params", () => {
    expect(buildLaneActionClearedSearch("?action=batch&laneId=lane-a&laneIds=lane-a,lane-b&inspectorTab=work"))
      .toBe("?inspectorTab=work");
  });
});

describe("planLaneDeleteBatches", () => {
  it("runs independent lanes in the same delete batch", () => {
    const batches = planLaneDeleteBatches([
      { id: "lane-a", parentLaneId: null },
      { id: "lane-b", parentLaneId: null },
      { id: "lane-c", parentLaneId: "lane-x" },
    ]);

    expect(batches.map((batch) => batch.map((lane) => lane.id))).toEqual([["lane-a", "lane-b", "lane-c"]]);
  });

  it("deletes selected child lanes before their selected parents", () => {
    const batches = planLaneDeleteBatches([
      { id: "lane-parent", parentLaneId: null },
      { id: "lane-child", parentLaneId: "lane-parent" },
      { id: "lane-grandchild", parentLaneId: "lane-child" },
      { id: "lane-sibling", parentLaneId: "lane-parent" },
    ]);

    expect(batches.map((batch) => batch.map((lane) => lane.id))).toEqual([
      ["lane-grandchild", "lane-sibling"],
      ["lane-child"],
      ["lane-parent"],
    ]);
  });
});

describe("laneHasAncestor", () => {
  it("walks the full lane graph without hanging on corrupted cycles", () => {
    const lanes = [
      { id: "child", parentLaneId: "middle" },
      { id: "middle", parentLaneId: "child" },
      { id: "root", parentLaneId: null },
    ];
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane] as const));

    expect(laneHasAncestor("child", "middle", lanesById)).toBe(true);
    expect(laneHasAncestor("child", "root", lanesById)).toBe(false);
  });
});

describe("resolveLaneDeleteStartSelection", () => {
  it("moves selection and active panes away from lanes that just started deleting", () => {
    const result = resolveLaneDeleteStartSelection({
      deletingLaneIds: ["lane-b"],
      selectedLaneId: "lane-b",
      activeLaneIds: ["lane-b", "lane-c"],
      pinnedLaneIds: ["lane-b", "lane-d"],
      filteredLaneIds: ["lane-b", "lane-c", "lane-d"],
      sortedLaneIds: ["lane-main", "lane-b", "lane-c", "lane-d"],
    });

    expect(result.selectedLaneId).toBe("lane-c");
    expect(result.activeLaneIds).toEqual(["lane-c", "lane-d"]);
    expect(Array.from(result.pinnedLaneIds)).toEqual(["lane-d"]);
  });

  it("keeps the current selected lane when a different split starts deleting", () => {
    const result = resolveLaneDeleteStartSelection({
      deletingLaneIds: ["lane-c"],
      selectedLaneId: "lane-b",
      activeLaneIds: ["lane-b", "lane-c", "lane-d"],
      pinnedLaneIds: [],
      filteredLaneIds: ["lane-b", "lane-c", "lane-d"],
      sortedLaneIds: ["lane-main", "lane-b", "lane-c", "lane-d"],
    });

    expect(result.selectedLaneId).toBe("lane-b");
    expect(result.activeLaneIds).toEqual(["lane-b", "lane-d"]);
  });

  it("falls back through sortedLaneIds when every filtered lane is being deleted", () => {
    const result = resolveLaneDeleteStartSelection({
      deletingLaneIds: ["lane-b", "lane-c", "lane-d"],
      selectedLaneId: "lane-b",
      activeLaneIds: ["lane-b", "lane-c"],
      pinnedLaneIds: ["lane-b", "lane-d"],
      // Every filtered lane is being deleted, so the function must fall
      // through to sortedLaneIds and pick the first non-deleting entry there
      // (lane-main) rather than re-selecting one of the deleting lanes.
      filteredLaneIds: ["lane-b", "lane-c", "lane-d"],
      sortedLaneIds: ["lane-main", "lane-b", "lane-c", "lane-d"],
    });

    expect(result.selectedLaneId).toBe("lane-main");
    expect(result.activeLaneIds).toEqual(["lane-main"]);
    expect(Array.from(result.pinnedLaneIds)).toEqual([]);
  });
});

describe("resolveVisibleLaneIds", () => {
  it("keeps a fallback lane visible when every filtered lane is deleting", () => {
    expect(resolveVisibleLaneIds({
      activeLaneIds: ["lane-main"],
      existingLaneIds: ["lane-main", "lane-deleting"],
      filteredLaneIds: ["lane-deleting"],
      selectableFilteredLaneIds: [],
      deletingLaneIds: ["lane-deleting"],
    })).toEqual(["lane-main"]);
  });

  it("does not bypass an ordinary empty filter", () => {
    expect(resolveVisibleLaneIds({
      activeLaneIds: ["lane-main"],
      existingLaneIds: ["lane-main", "lane-other"],
      filteredLaneIds: [],
      selectableFilteredLaneIds: [],
      deletingLaneIds: [],
    })).toEqual([]);
  });

  it("keeps normal filter scoping when a selectable filtered lane remains", () => {
    expect(resolveVisibleLaneIds({
      activeLaneIds: ["lane-main", "lane-other"],
      existingLaneIds: ["lane-main", "lane-other", "lane-deleting"],
      filteredLaneIds: ["lane-deleting", "lane-other"],
      selectableFilteredLaneIds: ["lane-other"],
      deletingLaneIds: ["lane-deleting"],
    })).toEqual(["lane-other"]);
  });
});

describe("getDeferredLanePaneDelayMs", () => {
  it("keeps the first visible lane eager and staggers later lanes", () => {
    const visibleLaneIds = ["lane-a", "lane-b", "lane-c"];

    expect(getDeferredLanePaneDelayMs({ laneId: "lane-a", visibleLaneIds, stepMs: 100 })).toBe(0);
    expect(getDeferredLanePaneDelayMs({ laneId: "lane-b", visibleLaneIds, stepMs: 100 })).toBe(100);
    expect(getDeferredLanePaneDelayMs({ laneId: "lane-c", visibleLaneIds, stepMs: 100 })).toBe(200);
  });

  it("does not defer unknown lanes and caps long queues", () => {
    expect(getDeferredLanePaneDelayMs({
      laneId: "lane-z",
      visibleLaneIds: ["lane-a", "lane-b"],
      stepMs: 100,
      maxMs: 150,
    })).toBe(0);
    expect(getDeferredLanePaneDelayMs({
      laneId: "lane-d",
      visibleLaneIds: ["lane-a", "lane-b", "lane-c", "lane-d"],
      stepMs: 100,
      maxMs: 150,
    })).toBe(150);
  });
});

describe("buildLaneSplitColumnsKey", () => {
  it("does not depend on the current split lane ids", () => {
    const beforeDelete = buildLaneSplitColumnsKey({
      laneTilingLayoutSuffix: ":wf",
      gridResetKey: 2,
    });
    const afterDelete = buildLaneSplitColumnsKey({
      laneTilingLayoutSuffix: ":wf",
      gridResetKey: 2,
    });

    expect(afterDelete).toBe(beforeDelete);
  });
});

describe("selectLanePrTag", () => {
  it("surfaces a merged PR when it still matches the lane branch", () => {
    const mergedPr = makePr({ state: "merged" });

    expect(selectLanePrTag(makeLane(), [mergedPr])).toBe(mergedPr);
  });

  it("ignores PR rows whose head branch no longer matches the lane branch", () => {
    const stalePr = makePr({
      state: "merged",
      headBranch: "ade/old-pr-state",
    });

    expect(selectLanePrTag(makeLane(), [stalePr])).toBeNull();
  });

  it("ignores PR rows when either side has no branch to compare", () => {
    expect(selectLanePrTag(makeLane({ branchRef: "" }), [makePr()])).toBeNull();
    expect(selectLanePrTag(makeLane(), [makePr({ headBranch: "" })])).toBeNull();
  });

  it("prefers active PR rows over merged rows for the same lane branch", () => {
    const mergedPr = makePr({
      id: "pr-merged",
      state: "merged",
      githubPrNumber: 223,
      updatedAt: "2026-05-03T00:00:00.000Z",
    });
    const openPr = makePr({
      id: "pr-open",
      state: "open",
      githubPrNumber: 224,
      updatedAt: "2026-05-01T00:00:00.000Z",
    });

    expect(selectLanePrTag(makeLane(), [mergedPr, openPr])).toBe(openPr);
  });

  it("does not match a primary lane that is currently on its base branch", () => {
    expect(
      lanePrMatchesCurrentBranch(
        makeLane({
          laneType: "primary",
          branchRef: "main",
          baseRef: "main",
        }),
        makePr({
          headBranch: "main",
        }),
      ),
    ).toBe(false);
  });
});

describe("runLaneDeleteBatchWithConcurrency", () => {
  it("runs independent lane deletes two at a time and preserves failures", async () => {
    const lanes = [
      { id: "lane-a", parentLaneId: null },
      { id: "lane-b", parentLaneId: null },
      { id: "lane-c", parentLaneId: null },
    ];
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirstWave: (() => void) | null = null;
    const firstWaveGate = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    let firstWaveStarted: (() => void) | null = null;
    const firstWaveStartedPromise = new Promise<void>((resolve) => {
      firstWaveStarted = resolve;
    });

    const resultsPromise = runLaneDeleteBatchWithConcurrency(lanes, async (lane) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(lane.id);
      if (starts.length === 2) firstWaveStarted?.();
      if (lane.id !== "lane-c") await firstWaveGate;
      if (lane.id === "lane-b") {
        active -= 1;
        throw new Error("locked");
      }
      active -= 1;
    });

    await firstWaveStartedPromise;
    expect(starts).toEqual(["lane-a", "lane-b"]);
    expect(maxActive).toBe(2);

    expect(releaseFirstWave).not.toBeNull();
    releaseFirstWave!();
    const results = await resultsPromise;

    expect(starts).toEqual(["lane-a", "lane-b", "lane-c"]);
    expect(results.map((result) => [result.lane.id, result.status])).toEqual([
      ["lane-a", "fulfilled"],
      ["lane-b", "rejected"],
      ["lane-c", "fulfilled"],
    ]);
  });
});

describe("selectLaneTabPrTag", () => {
  it("falls back to repo GitHub PRs by lane branch when no ADE PR row is mapped", () => {
    const githubPr = makeGitHubPr({
      state: "merged",
      linkedPrId: null,
      headBranch: "ade/pr-state",
    });

    expect(githubPrMatchesCurrentBranch(makeLane(), githubPr)).toBe(true);
    expect(selectGithubLanePrTag(makeLane(), [githubPr])).toBe(githubPr);
    expect(selectLaneTabPrTag(makeLane(), [], [githubPr])).toMatchObject({
      source: "github",
      linkedPrId: null,
      githubPrNumber: 224,
      state: "merged",
    });
  });

  it("prefers an ADE-mapped PR over an unlinked GitHub branch match", () => {
    const mappedPr = makePr({ id: "mapped-pr", state: "open" });
    const githubPr = makeGitHubPr({ id: "github-pr", state: "open" });

    expect(selectLaneTabPrTag(makeLane(), [mappedPr], [githubPr])).toMatchObject({
      source: "ade",
      id: "mapped-pr",
      linkedPrId: "mapped-pr",
      state: "open",
    });
  });

  it("prefers an external GitHub PR over a stale terminal ADE row for the same branch", () => {
    const mappedPr = makePr({
      id: "mapped-pr",
      state: "closed",
      githubPrNumber: 123,
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const githubPr = makeGitHubPr({
      id: "github-pr",
      state: "open",
      githubPrNumber: 224,
      linkedPrId: null,
      linkedLaneId: null,
      title: "Fresh external PR",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(selectLaneTabPrTag(makeLane(), [mappedPr], [githubPr])).toMatchObject({
      source: "github",
      id: "github-pr",
      linkedPrId: null,
      state: "open",
      title: "Fresh external PR",
    });
  });

  it("keeps a terminal ADE row when the branch-matched GitHub PR is also terminal and unrelated", () => {
    const mappedPr = makePr({
      id: "mapped-pr",
      state: "closed",
      githubPrNumber: 123,
      githubUrl: "https://github.com/arul28/ADE/pull/123",
    });
    const githubPr = makeGitHubPr({
      id: "github-pr",
      state: "closed",
      githubPrNumber: 224,
      githubUrl: "https://github.com/arul28/ADE/pull/224",
      linkedPrId: null,
      linkedLaneId: null,
    });

    expect(selectLaneTabPrTag(makeLane(), [mappedPr], [githubPr])).toMatchObject({
      source: "ade",
      id: "mapped-pr",
      linkedPrId: "mapped-pr",
      state: "closed",
      githubPrNumber: 123,
    });
  });

  it("uses a fresh GitHub terminal state over a stale open ADE row for the same PR", () => {
    const mappedPr = makePr({ id: "mapped-pr", state: "open" });
    const githubPr = makeGitHubPr({
      id: "github-pr",
      state: "merged",
      linkedPrId: "mapped-pr",
      linkedLaneId: "lane-1",
      title: "Merged upstream",
    });

    expect(selectLaneTabPrTag(makeLane(), [mappedPr], [githubPr])).toMatchObject({
      source: "github",
      id: "github-pr",
      linkedPrId: "mapped-pr",
      state: "merged",
      title: "Merged upstream",
    });
  });

  it("keeps the ADE row when the GitHub match is not the same PR", () => {
    const mappedPr = makePr({ id: "mapped-pr", state: "open", githubPrNumber: 224 });
    const githubPr = makeGitHubPr({
      id: "github-pr",
      state: "merged",
      githubPrNumber: 999,
      githubUrl: "https://github.com/arul28/ADE/pull/999",
      linkedPrId: "other-pr",
      linkedLaneId: "lane-1",
    });

    expect(selectLaneTabPrTag(makeLane(), [mappedPr], [githubPr])).toMatchObject({
      source: "ade",
      id: "mapped-pr",
      state: "open",
    });
  });

  it("labels GitHub-only draft PRs as draft lane tags", () => {
    expect(selectLaneTabPrTag(makeLane(), [], [
      makeGitHubPr({
        state: "open",
        isDraft: true,
      }),
    ])).toMatchObject({
      source: "github",
      state: "draft",
    });
  });

  it("does not route a branch-matched GitHub PR through a stale linked lane", () => {
    const githubPr = makeGitHubPr({
      linkedPrId: "other-pr",
      linkedLaneId: "other-lane",
    });

    expect(selectLaneTabPrTag(makeLane(), [], [githubPr])).toMatchObject({
      source: "github",
      linkedPrId: null,
      githubUrl: "https://github.com/arul28/ADE/pull/224",
    });
  });

  it("does not match fork PRs to same-named local repo branches", () => {
    expect(
      githubPrMatchesCurrentBranch(
        makeLane(),
        makeGitHubPr({
          headBranch: "ade/pr-state",
          headRepoOwner: "contributor",
          headRepoName: "ADE",
        }),
      ),
    ).toBe(false);
  });

  it("does not match repo GitHub PRs for primary while primary is on its base branch", () => {
    expect(
      githubPrMatchesCurrentBranch(
        makeLane({
          laneType: "primary",
          branchRef: "main",
          baseRef: "main",
        }),
        makeGitHubPr({ headBranch: "main" }),
      ),
    ).toBe(false);
  });
});

describe("selectVisibleLanePrRefreshIds", () => {
  it("selects stale linked PRs for visible lanes in visible order", () => {
    const lanePrByLaneId = new Map([
      ["lane-2", { ...selectLaneTabPrTag(makeLane({ id: "lane-2", branchRef: "ade/two" }), [makePr({ id: "pr-2", laneId: "lane-2", headBranch: "ade/two" })], [])!, linkedPrId: "pr-2" }],
      ["lane-1", { ...selectLaneTabPrTag(makeLane(), [makePr()], [])!, linkedPrId: "pr-1" }],
    ]);

    expect(selectVisibleLanePrRefreshIds({
      visibleLaneIds: ["lane-1", "lane-2"],
      lanePrByLaneId,
      prs: [
        makePr({ id: "pr-1", lastSyncedAt: "2026-05-01T00:00:00.000Z" }),
        makePr({ id: "pr-2", laneId: "lane-2", headBranch: "ade/two", lastSyncedAt: "2026-05-01T00:00:01.000Z" }),
      ],
      nowMs: Date.parse("2026-05-01T00:01:00.000Z"),
      limit: 4,
    })).toEqual(["pr-1", "pr-2"]);
  });

  it("skips fresh, recently requested, and GitHub-only PR tags", () => {
    const nowMs = Date.parse("2026-05-01T00:01:00.000Z");
    const lanePrByLaneId = new Map([
      ["fresh", { ...selectLaneTabPrTag(makeLane({ id: "fresh", branchRef: "ade/fresh" }), [makePr({ id: "fresh-pr", laneId: "fresh", headBranch: "ade/fresh" })], [])!, linkedPrId: "fresh-pr" }],
      ["recent", { ...selectLaneTabPrTag(makeLane({ id: "recent", branchRef: "ade/recent" }), [makePr({ id: "recent-pr", laneId: "recent", headBranch: "ade/recent" })], [])!, linkedPrId: "recent-pr" }],
      ["github", { ...selectLaneTabPrTag(makeLane({ id: "github", branchRef: "ade/github" }), [], [makeGitHubPr({ headBranch: "ade/github", linkedPrId: null })])!, linkedPrId: null }],
      ["stale", { ...selectLaneTabPrTag(makeLane({ id: "stale", branchRef: "ade/stale" }), [makePr({ id: "stale-pr", laneId: "stale", headBranch: "ade/stale" })], [])!, linkedPrId: "stale-pr" }],
    ]);

    expect(selectVisibleLanePrRefreshIds({
      visibleLaneIds: ["fresh", "recent", "github", "stale"],
      lanePrByLaneId,
      prs: [
        makePr({ id: "fresh-pr", laneId: "fresh", headBranch: "ade/fresh", lastSyncedAt: "2026-05-01T00:00:55.000Z" }),
        makePr({ id: "recent-pr", laneId: "recent", headBranch: "ade/recent", lastSyncedAt: "2026-05-01T00:00:00.000Z" }),
        makePr({ id: "stale-pr", laneId: "stale", headBranch: "ade/stale", lastSyncedAt: null }),
      ],
      recentlyRequestedAtByPrId: new Map([["recent-pr", nowMs - 5_000]]),
      nowMs,
      staleMs: 15_000,
      limit: 4,
    })).toEqual(["stale-pr"]);
  });

  it("dedupes and caps linked PR refreshes", () => {
    const lanePrByLaneId = new Map([
      ["lane-1", { ...selectLaneTabPrTag(makeLane(), [makePr({ id: "shared-pr" })], [])!, linkedPrId: "shared-pr" }],
      ["lane-2", { ...selectLaneTabPrTag(makeLane({ id: "lane-2", branchRef: "ade/two" }), [makePr({ id: "shared-pr", laneId: "lane-2", headBranch: "ade/two" })], [])!, linkedPrId: "shared-pr" }],
      ["lane-3", { ...selectLaneTabPrTag(makeLane({ id: "lane-3", branchRef: "ade/three" }), [makePr({ id: "pr-3", laneId: "lane-3", headBranch: "ade/three" })], [])!, linkedPrId: "pr-3" }],
    ]);

    expect(selectVisibleLanePrRefreshIds({
      visibleLaneIds: ["lane-1", "lane-2", "lane-3"],
      lanePrByLaneId,
      prs: [
        makePr({ id: "shared-pr", lastSyncedAt: null }),
        makePr({ id: "pr-3", laneId: "lane-3", headBranch: "ade/three", lastSyncedAt: null }),
      ],
      limit: 1,
    })).toEqual(["shared-pr"]);
  });
});

describe("sortLaneListRows", () => {
  it("keeps primary first and promotes pinned lanes before runtime buckets", () => {
    const lanes = [
      { id: "primary", laneType: "primary" },
      { id: "running", laneType: "worktree" },
      { id: "pinned-ended", laneType: "worktree" },
      { id: "idle", laneType: "worktree" },
    ] as const;

    const result = sortLaneListRows({
      lanes: [...lanes],
      laneRuntimeById: new Map([
        ["running", { bucket: "running" }],
        ["pinned-ended", { bucket: "ended" }],
        ["idle", { bucket: "none" }],
      ]),
      laneStatusFilter: "all",
      laneOrderById: new Map(lanes.map((lane, index) => [lane.id, index])),
      pinnedLaneIds: new Set(["pinned-ended"]),
    });

    expect(result.map((lane) => lane.id)).toEqual(["primary", "pinned-ended", "running", "idle"]);
  });

  it("keeps pinned ordering after applying a status filter", () => {
    const lanes = [
      { id: "running-a", laneType: "worktree" },
      { id: "running-pinned", laneType: "worktree" },
      { id: "ended", laneType: "worktree" },
    ] as const;

    const result = sortLaneListRows({
      lanes: [...lanes],
      laneRuntimeById: new Map([
        ["running-a", { bucket: "running" }],
        ["running-pinned", { bucket: "running" }],
        ["ended", { bucket: "ended" }],
      ]),
      laneStatusFilter: "running",
      laneOrderById: new Map(lanes.map((lane, index) => [lane.id, index])),
      pinnedLaneIds: new Set(["running-pinned"]),
    });

    expect(result.map((lane) => lane.id)).toEqual(["running-pinned", "running-a"]);
  });
});

describe("shouldMountGitActionsPane", () => {
  it("mounts one Git Actions pane owner when a lane is expanded", () => {
    expect(shouldMountGitActionsPane({
      laneId: "lane-1",
      expandedGitActionsLaneId: "lane-1",
      surface: "inline",
    })).toBe(false);

    expect(shouldMountGitActionsPane({
      laneId: "lane-1",
      expandedGitActionsLaneId: "lane-1",
      surface: "git-actions-fullscreen",
    })).toBe(true);

    expect(shouldMountGitActionsPane({
      laneId: "lane-2",
      expandedGitActionsLaneId: "lane-1",
      surface: "inline",
    })).toBe(true);

    expect(shouldMountGitActionsPane({
      laneId: "lane-1",
      expandedGitActionsLaneId: null,
      surface: "inline",
    })).toBe(true);
  });
});
