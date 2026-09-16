import { describe, expect, it } from "vitest";
import type { PrSummary } from "./types";
import {
  chatHasExplicitPrEdges,
  isGithubStackFullyLanded,
  parsePrNumberQuery,
  rankPrFilesByChurn,
  selectPrsForChat,
  sessionHasOpenLinkedPrs,
} from "./prChatScope";

function pr(over: Partial<PrSummary> & { id: string }): PrSummary {
  return {
    laneId: "lane-1",
    projectId: "proj",
    repoOwner: "o",
    repoName: "r",
    githubPrNumber: 1,
    githubUrl: "https://github.com/o/r/pull/1",
    githubNodeId: null,
    title: over.id,
    state: "open",
    baseBranch: "main",
    headBranch: "feat/a",
    checksStatus: "none",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("selectPrsForChat", () => {
  it("returns only explicit edges when the chat has any", () => {
    const prs = [
      pr({ id: "legacy", headBranch: "feat/a" }),
      pr({ id: "a", chatSessionIds: ["chat-a"], headBranch: "feat/a" }),
      pr({ id: "b", chatSessionIds: ["chat-b"], headBranch: "feat/b" }),
    ];
    expect(selectPrsForChat(prs, "chat-a").map((row) => row.id)).toEqual(["a"]);
    expect(chatHasExplicitPrEdges(prs, "chat-a")).toBe(true);
  });

  it("never shows a PR another chat claimed to a zero-edge chat", () => {
    const prs = [
      pr({ id: "claimed", chatSessionIds: ["chat-a"] }),
      pr({ id: "open", headBranch: "feat/c" }),
    ];
    expect(selectPrsForChat(prs, "chat-c", { currentBranch: "feat/c" }).map((row) => row.id)).toEqual(["open"]);
  });

  it("does not revive a dismissed unlink as current-branch fallback", () => {
    const prs = [
      pr({ id: "unlinked", headBranch: "feat/a", dismissedChatSessionIds: ["chat-a"] }),
    ];
    expect(selectPrsForChat(prs, "chat-a", { currentBranch: "feat/a" })).toEqual([]);
  });

  it("shows unedged current-branch PRs only when the chat has no edges", () => {
    const prs = [
      pr({ id: "this-branch", headBranch: "feat/a" }),
      pr({ id: "other-branch", headBranch: "feat/b" }),
    ];
    expect(selectPrsForChat(prs, "chat-a", { currentBranch: "feat/a" }).map((row) => row.id)).toEqual(["this-branch"]);
  });

  it("keeps cross-lane stack members that this chat linked", () => {
    const prs = [
      pr({ id: "child", laneId: "lane-child", chatSessionIds: ["chat-child"] }),
      pr({ id: "parent", laneId: "lane-parent", chatSessionIds: ["chat-child"] }),
    ];
    expect(selectPrsForChat(prs, "chat-child").map((row) => row.id)).toEqual(["child", "parent"]);
  });
});

describe("parsePrNumberQuery", () => {
  it("reads a bare or hashed PR number", () => {
    expect(parsePrNumberQuery("#10870")).toBe(10870);
    expect(parsePrNumberQuery("42")).toBe(42);
    expect(parsePrNumberQuery("pr 42")).toBeNull();
  });
});

describe("rankPrFilesByChurn", () => {
  it("returns the three highest-churn files", () => {
    const ranked = rankPrFilesByChurn([
      { filename: "a.ts", additions: 1, deletions: 1, status: "modified", patch: null, previousFilename: null },
      { filename: "b.ts", additions: 40, deletions: 2, status: "modified", patch: null, previousFilename: null },
      { filename: "c.ts", additions: 8, deletions: 8, status: "modified", patch: null, previousFilename: null },
      { filename: "d.ts", additions: 3, deletions: 0, status: "added", patch: null, previousFilename: null },
    ], 3);
    expect(ranked.files.map((file) => file.filename)).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(ranked.remaining).toBe(1);
  });
});

describe("sessionHasOpenLinkedPrs", () => {
  it("ignores fallback unedged PRs when deciding whether a chat can settle", () => {
    const prs = [
      pr({ id: "linked-open", chatSessionIds: ["chat-a"], state: "open" }),
      pr({ id: "unedged", state: "open" }),
    ];
    expect(sessionHasOpenLinkedPrs(prs, "chat-a", { excludingPrId: "merged" })).toBe(true);
    expect(sessionHasOpenLinkedPrs([
      pr({ id: "merged", chatSessionIds: ["chat-a"], state: "merged" }),
      pr({ id: "unedged", state: "open" }),
    ], "chat-a", { excludingPrId: "merged" })).toBe(false);
  });
});

describe("isGithubStackFullyLanded", () => {
  it("requires every sibling to be merged", () => {
    expect(isGithubStackFullyLanded([
      pr({ id: "a", state: "merged", mergedAt: "2026-01-01T00:00:00.000Z" }),
      pr({ id: "b", state: "open" }),
    ])).toBe(false);
    expect(isGithubStackFullyLanded([
      pr({ id: "a", state: "merged", mergedAt: "2026-01-01T00:00:00.000Z" }),
      pr({ id: "b", state: "merged", mergedAt: "2026-01-02T00:00:00.000Z" }),
    ])).toBe(true);
  });
});
