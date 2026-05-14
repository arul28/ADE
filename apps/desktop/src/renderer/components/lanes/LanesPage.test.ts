import { describe, expect, it } from "vitest";
import {
  githubPrMatchesCurrentBranch,
  laneHasAncestor,
  lanePrMatchesCurrentBranch,
  planLaneDeleteBatches,
  resolveLaneDeleteStartSelection,
  resolveCreateLaneRequest,
  resolveLaneIdsDeepLinkSelection,
  resolveVisibleLaneIds,
  selectGithubLanePrTag,
  selectLaneTabPrTag,
  selectLanePrTag,
  sortLaneListRows,
} from "./lanePageModel";
import { shouldMountGitActionsPane } from "./LanesPage";
import type { GitHubPrListItem, LaneSummary, PrSummary } from "../../../shared/types";

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
    const mappedPr = makePr({ id: "mapped-pr", state: "closed" });
    const githubPr = makeGitHubPr({ id: "github-pr", state: "open" });

    expect(selectLaneTabPrTag(makeLane(), [mappedPr], [githubPr])).toMatchObject({
      source: "ade",
      id: "mapped-pr",
      linkedPrId: "mapped-pr",
      state: "closed",
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
