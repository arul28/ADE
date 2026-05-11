import { describe, expect, it } from "vitest";
import {
  lanePrMatchesCurrentBranch,
  resolveLaneDeleteStartSelection,
  resolveCreateLaneRequest,
  resolveLaneIdsDeepLinkSelection,
  selectLanePrTag,
  shouldMountGitActionsPane,
} from "./LanesPage";
import type { LaneSummary, PrSummary } from "../../../shared/types";

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

describe("shouldMountGitActionsPane", () => {
  it("keeps the fullscreen Git Actions pane mounted while suppressing the hidden inline duplicate", () => {
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
  });

  it("keeps inline Git Actions mounted for lanes that are not expanded", () => {
    expect(shouldMountGitActionsPane({
      laneId: "lane-2",
      expandedGitActionsLaneId: "lane-1",
      surface: "inline",
    })).toBe(true);
  });
});
