import { describe, expect, it } from "vitest";
import type { BranchPullRequest } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import {
  formatRelativeTime,
  matchesQuery,
  parseSearchQuery,
} from "./branchPickerSearch";

const NOW = Date.parse("2026-04-30T12:00:00Z");

function makeBranch(overrides: Partial<LaneBranchOption> = {}): LaneBranchOption {
  return {
    name: "feat/widget",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    lastCommitAuthor: "Arul Sharma",
    lastCommitMessage: "tweak widget alignment",
    lastCommitDate: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makePr(overrides: Partial<BranchPullRequest> = {}): BranchPullRequest {
  return {
    branch: "feat/widget",
    prNumber: 812,
    title: "Add widget alignment options",
    state: "open",
    url: "https://github.com/example/repo/pull/812",
    author: "arulsharma",
    updatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("parseSearchQuery", () => {
  it("treats plain text as free-text", () => {
    expect(parseSearchQuery("widget alignment")).toEqual({
      tokens: [],
      freeText: "widget alignment",
    });
  });

  it("parses pr:open / pr:none / pr:draft", () => {
    expect(parseSearchQuery("pr:open").tokens).toEqual([{ kind: "pr", value: "open" }]);
    expect(parseSearchQuery("pr:none").tokens).toEqual([{ kind: "pr", value: "none" }]);
    expect(parseSearchQuery("pr:draft").tokens).toEqual([{ kind: "pr", value: "draft" }]);
  });

  it("ignores unknown pr: values, treats them as free text", () => {
    const parsed = parseSearchQuery("pr:bogus");
    expect(parsed.tokens).toEqual([]);
    expect(parsed.freeText).toBe("pr:bogus");
  });

  it("parses author:NAME and author:me", () => {
    expect(parseSearchQuery("author:jamie").tokens).toEqual([
      { kind: "author", value: "jamie", isMe: false },
    ]);
    expect(parseSearchQuery("author:me").tokens).toEqual([
      { kind: "author", value: "me", isMe: true },
    ]);
  });

  it("parses mine alias", () => {
    expect(parseSearchQuery("mine").tokens).toEqual([{ kind: "mine" }]);
  });

  it("parses stale:Nd", () => {
    expect(parseSearchQuery("stale:30d").tokens).toEqual([{ kind: "stale", days: 30 }]);
    expect(parseSearchQuery("stale:7").tokens).toEqual([{ kind: "stale", days: 7 }]);
  });

  it("parses #PRNUMBER", () => {
    expect(parseSearchQuery("#812").tokens).toEqual([{ kind: "prNumber", value: 812 }]);
  });

  it("ANDs tokens and free text together", () => {
    const parsed = parseSearchQuery("pr:open author:me widget");
    expect(parsed.tokens).toHaveLength(2);
    expect(parsed.freeText).toBe("widget");
  });
});

describe("matchesQuery", () => {
  const ctx = (
    overrides: Partial<{ branch: LaneBranchOption; pr: BranchPullRequest | null; user: string }> = {},
  ) => ({
    branch: overrides.branch ?? makeBranch(),
    pr: overrides.pr === undefined ? makePr() : overrides.pr,
    currentUserName: overrides.user ?? "Arul Sharma",
    now: NOW,
  });

  it("free-text matches branch name", () => {
    expect(matchesQuery(ctx(), parseSearchQuery("widg"))).toBe(true);
    expect(matchesQuery(ctx(), parseSearchQuery("rocket"))).toBe(false);
  });

  it("free-text matches PR title", () => {
    expect(matchesQuery(ctx(), parseSearchQuery("alignment options"))).toBe(true);
  });

  it("free-text matches PR number with hash prefix", () => {
    expect(matchesQuery(ctx(), parseSearchQuery("#812"))).toBe(true);
  });

  it("pr:open keeps branches with open PR (including drafts)", () => {
    expect(matchesQuery(ctx(), parseSearchQuery("pr:open"))).toBe(true);
    expect(matchesQuery(ctx({ pr: makePr({ state: "draft" }) }), parseSearchQuery("pr:open"))).toBe(true);
    expect(matchesQuery(ctx({ pr: null }), parseSearchQuery("pr:open"))).toBe(false);
  });

  it("pr:none keeps branches with no PR", () => {
    expect(matchesQuery(ctx({ pr: null }), parseSearchQuery("pr:none"))).toBe(true);
    expect(matchesQuery(ctx(), parseSearchQuery("pr:none"))).toBe(false);
  });

  it("pr:draft keeps draft PRs only", () => {
    expect(matchesQuery(ctx({ pr: makePr({ state: "draft" }) }), parseSearchQuery("pr:draft"))).toBe(true);
    expect(matchesQuery(ctx(), parseSearchQuery("pr:draft"))).toBe(false);
  });

  it("author:me matches the current user (case-insensitive substring)", () => {
    expect(matchesQuery(ctx(), parseSearchQuery("author:me"))).toBe(true);
    expect(matchesQuery(ctx({ user: "Jamie" }), parseSearchQuery("author:me"))).toBe(false);
  });

  it("mine is an alias for author:me", () => {
    expect(matchesQuery(ctx(), parseSearchQuery("mine"))).toBe(true);
    expect(matchesQuery(ctx({ user: "Jamie" }), parseSearchQuery("mine"))).toBe(false);
  });

  it("stale:Nd filters by commit age", () => {
    const fresh = ctx({
      branch: makeBranch({ lastCommitDate: new Date(NOW - 1 * 24 * 60 * 60 * 1000).toISOString() }),
    });
    const stale = ctx({
      branch: makeBranch({ lastCommitDate: new Date(NOW - 60 * 24 * 60 * 60 * 1000).toISOString() }),
    });
    expect(matchesQuery(fresh, parseSearchQuery("stale:30d"))).toBe(false);
    expect(matchesQuery(stale, parseSearchQuery("stale:30d"))).toBe(true);
  });

  it("ANDs multiple tokens", () => {
    const mineOpen = parseSearchQuery("pr:open mine");
    expect(matchesQuery(ctx(), mineOpen)).toBe(true);
    expect(matchesQuery(ctx({ pr: null }), mineOpen)).toBe(false);
    expect(matchesQuery(ctx({ user: "Jamie" }), mineOpen)).toBe(false);
  });
});

describe("formatRelativeTime", () => {
  it("returns empty for missing input", () => {
    expect(formatRelativeTime(undefined, NOW)).toBe("");
  });

  it("formats seconds, minutes, hours, days", () => {
    expect(formatRelativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("30s");
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m");
    expect(formatRelativeTime(new Date(NOW - 3 * 60 * 60_000).toISOString(), NOW)).toBe("3h");
    expect(formatRelativeTime(new Date(NOW - 4 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("4d");
  });
});
