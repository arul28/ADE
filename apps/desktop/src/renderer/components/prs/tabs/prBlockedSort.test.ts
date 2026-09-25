import { describe, expect, it } from "vitest";
import type { GitHubPrListItem } from "../../../../shared/types";
import {
  compareGitHubRows,
  githubRowBlockedTier,
  normalizeGitHubTabSort,
  resolveGitHubRowNextStepKind,
  type GitHubRowBlockerSource,
} from "./prBlockedSort";

function item(overrides: Partial<GitHubPrListItem> = {}): GitHubPrListItem {
  return {
    id: "gh:arul28/ADE#1",
    scope: "repo",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 1,
    githubUrl: "https://github.com/arul28/ADE/pull/1",
    title: "A PR",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "feature",
    author: "arul28",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
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

function kindFor(state: GitHubPrListItem["state"], source: GitHubRowBlockerSource | null, isDraft = false) {
  return resolveGitHubRowNextStepKind({ state, isDraft, baseBranch: "main", source });
}

describe("prBlockedSort", () => {
  it("normalizes only the two known sort values", () => {
    expect(normalizeGitHubTabSort("blocked")).toBe("blocked");
    expect(normalizeGitHubTabSort("updated")).toBe("updated");
    expect(normalizeGitHubTabSort(undefined)).toBe("updated");
    expect(normalizeGitHubTabSort("nonsense")).toBe("updated");
  });

  it("maps each next step to a blocked tier", () => {
    expect(githubRowBlockedTier("conflicts")).toBe(0);
    expect(githubRowBlockedTier("behind")).toBe(0);
    expect(githubRowBlockedTier("checks_failing")).toBe(0);
    expect(githubRowBlockedTier("changes_requested")).toBe(0);
    expect(githubRowBlockedTier("review_required")).toBe(0);
    expect(githubRowBlockedTier("rules_blocked")).toBe(0);
    expect(githubRowBlockedTier("checks_pending")).toBe(1);
    expect(githubRowBlockedTier("auto_merge_armed")).toBe(1);
    expect(githubRowBlockedTier("computing")).toBe(1);
    expect(githubRowBlockedTier("ready")).toBe(2);
    expect(githubRowBlockedTier("draft")).toBe(2);
    expect(githubRowBlockedTier("merged")).toBe(2);
    expect(githubRowBlockedTier("closed")).toBe(2);
  });

  it("derives the next step from the row and its linked status", () => {
    expect(kindFor("merged", null)).toBe("merged");
    expect(kindFor("closed", null)).toBe("closed");
    expect(kindFor("draft", null)).toBe("draft");
    expect(kindFor("open", null)).toBe("ready");
    expect(kindFor("open", { mergeConflicts: true })).toBe("conflicts");
    expect(kindFor("open", { behindBaseBy: 3 })).toBe("behind");
    expect(kindFor("open", { checksStatus: "failing" })).toBe("checks_failing");
    expect(kindFor("open", { checksStatus: "pending" })).toBe("checks_pending");
    expect(kindFor("open", { reviewStatus: "changes_requested" })).toBe("changes_requested");
    expect(kindFor("open", { reviewStatus: "requested" })).toBe("review_required");
    // A draft arrives as `open` + `isDraft`; draft wins over a failing check.
    expect(kindFor("open", { checksStatus: "failing" }, true)).toBe("draft");
  });

  it("treats a host that reports no status as nothing outstanding", () => {
    expect(githubRowBlockedTier(kindFor("open", null))).toBe(2);
    expect(githubRowBlockedTier(kindFor("open", { reviewStatus: "none" }))).toBe(2);
  });

  it("orders blocked before waiting before clear, newest-first inside a tier", () => {
    const blocked = item({ id: "blocked", updatedAt: "2026-09-01T00:00:00Z" });
    const waiting = item({ id: "waiting", updatedAt: "2026-09-03T00:00:00Z" });
    const clear = item({ id: "clear", updatedAt: "2026-09-04T00:00:00Z" });
    const newerBlocked = item({ id: "blocked2", updatedAt: "2026-09-05T00:00:00Z" });
    const tiers: Record<string, number> = { blocked: 0, blocked2: 0, waiting: 1, clear: 2 };

    const sorted = [clear, blocked, waiting, newerBlocked]
      .sort((a, b) => compareGitHubRows(a, b, (row) => tiers[row.id] ?? 2))
      .map((row) => row.id);

    expect(sorted).toEqual(["blocked2", "blocked", "waiting", "clear"]);
  });
});
