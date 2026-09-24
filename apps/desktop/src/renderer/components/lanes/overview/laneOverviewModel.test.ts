import { describe, expect, it } from "vitest";
import type { LaneSummary, PrCheck, TerminalSessionSummary } from "../../../../shared/types";
import type { LaneHistoryPr } from "./laneHistoryModel";
import {
  LANE_CHATS_CAP,
  buildLaneChatRows,
  capRows,
  laneCreatedBy,
  laneOverviewSections,
  laneStatusItems,
  prMergeFact,
  prReviewFact,
  splitLanePrs,
  summarizePrChecks,
} from "./laneOverviewModel";

const NOW = Date.parse("2026-09-23T15:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function terminal(overrides: Partial<TerminalSessionSummary>): TerminalSessionSummary {
  return {
    id: "s",
    laneId: "lane-1",
    laneName: "Lane",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat",
    title: "Chat",
    status: "running",
    startedAt: at(60),
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    lastActivityAt: at(5),
    ...overrides,
  } as TerminalSessionSummary;
}

function pr(overrides: Partial<LaneHistoryPr>): LaneHistoryPr {
  return {
    key: "acme/ade#1",
    linkedPrId: "pr-1",
    number: 1,
    repoOwner: "acme",
    repoName: "ade",
    title: "PR",
    state: "open",
    createdAt: at(600),
    updatedAt: at(10),
    mergedAt: null,
    mergedBy: null,
    author: null,
    checksStatus: null,
    reviewStatus: null,
    mergeConflicts: null,
    ...overrides,
  };
}

function check(name: string, status: PrCheck["status"], conclusion: PrCheck["conclusion"]): PrCheck {
  return { name, status, conclusion, detailsUrl: null, startedAt: null, completedAt: null };
}

describe("buildLaneChatRows", () => {
  it("lists what needs you first, then working, then open, then done, newest first in each", () => {
    const rows = buildLaneChatRows({
      laneId: "lane-1",
      nowMs: NOW,
      chats: [],
      terminals: [
        terminal({ id: "done", status: "completed", runtimeState: "exited", endedAt: at(2), lastActivityAt: at(2) }),
        terminal({ id: "working-old", lastActivityAt: at(30) }),
        terminal({ id: "needs-you", runtimeState: "waiting-input", pendingInputItemId: "q1", lastActivityAt: at(50) }),
        terminal({ id: "working-new", lastActivityAt: at(1) }),
        // Not listed: a plain shell, a chat's own terminal, another lane, an archived chat.
        terminal({ id: "shell", toolType: "shell" }),
        terminal({ id: "child", toolType: "codex", chatSessionId: "working-new" }),
        terminal({ id: "other-lane", laneId: "lane-2" }),
        terminal({ id: "archived", archivedAt: at(1) }),
      ],
    });
    expect(rows.map((row) => row.sessionId)).toEqual(["needs-you", "working-new", "working-old", "done"]);
    expect(rows[0]!.presentation?.label).toBe("Needs you");
    expect(rows[1]!.presentation?.label).toBe("Working");
  });

  it("reads a chat without a terminal row from its summary and drops the title's spinner glyph", () => {
    const rows = buildLaneChatRows({
      laneId: "lane-1",
      nowMs: NOW,
      chats: [
        { sessionId: "old-chat", laneId: "lane-1", provider: "codex", model: "gpt", title: "Old chat", status: "ended", startedAt: at(900), endedAt: at(800), lastActivityAt: at(800) } as any,
        { sessionId: "mirrored", laneId: "lane-1", provider: "claude", model: "opus", title: "Mirrored", status: "active", startedAt: at(90), lastActivityAt: at(3) } as any,
      ],
      terminals: [terminal({ id: "mirrored", title: "◐ Fix lanes" })],
    });
    expect(rows.map((row) => [row.sessionId, row.title])).toEqual([["mirrored", "Fix lanes"], ["old-chat", "Old chat"]]);
    expect(rows[1]!.toolType).toBe("codex-chat");
    expect(rows[1]!.rank).toBe(3);
  });
});

describe("capRows", () => {
  it("caps at eight until expanded", () => {
    const rows = Array.from({ length: 11 }, (_, index) => index);
    expect(capRows(rows, false)).toEqual({ visible: rows.slice(0, LANE_CHATS_CAP), hidden: 3 });
    expect(capRows(rows, true)).toEqual({ visible: rows, hidden: 0 });
    expect(capRows(rows.slice(0, 5), false)).toEqual({ visible: rows.slice(0, 5), hidden: 0 });
  });
});

describe("summarizePrChecks", () => {
  it("gives failing and running checks a row each, worst first, and folds the rest", () => {
    const summary = summarizePrChecks([
      check("lint", "completed", "success"),
      check("build", "in_progress", null),
      check("unit", "completed", "failure"),
      check("docs", "completed", "skipped"),
      check("deploy", "queued", null),
    ]);
    expect(summary.attention.map((row) => `${row.name}:${row.state}`)).toEqual(["unit:failed", "build:running", "deploy:queued"]);
    expect(summary.quiet.map((row) => row.name)).toEqual(["docs", "lint"]);
    expect({ total: summary.total, passed: summary.passed, failed: summary.failed, running: summary.running })
      .toEqual({ total: 5, passed: 1, failed: 1, running: 2 });
  });

  it("has nothing to call out when every check passed", () => {
    const summary = summarizePrChecks([check("a", "completed", "success"), check("b", "completed", "success")]);
    expect(summary.attention).toEqual([]);
    expect(summary.passed).toBe(2);
  });
});

describe("prReviewFact / prMergeFact", () => {
  it("counts each reviewer's latest decision and ignores comments", () => {
    const reviews = [
      { reviewer: "a", reviewerAvatarUrl: null, state: "changes_requested" as const, body: null, submittedAt: at(60) },
      { reviewer: "a", reviewerAvatarUrl: null, state: "approved" as const, body: null, submittedAt: at(10) },
      { reviewer: "b", reviewerAvatarUrl: null, state: "commented" as const, body: null, submittedAt: at(5) },
    ];
    expect(prReviewFact({ reviews, reviewStatus: "approved", isDraft: false })).toEqual({ text: "Approved by a", tone: "success" });
    expect(prReviewFact({ reviews: [], reviewStatus: "requested", isDraft: false })).toEqual({ text: "Review requested", tone: "muted" });
    expect(prReviewFact({ reviews: [], reviewStatus: "none", isDraft: true })).toBeNull();
  });

  it("says conflicts first, then how far behind, then ready", () => {
    const base = { baseLabel: "main", isDraft: false, checksFailing: false, approved: true, mergeConflicts: null };
    expect(prMergeFact({ ...base, status: { mergeConflicts: true, isMergeable: false, behindBaseBy: 3 } })?.text).toBe("Conflicts with main");
    expect(prMergeFact({ ...base, status: { mergeConflicts: false, isMergeable: true, behindBaseBy: 3 } })?.text).toBe("3 commits behind main");
    expect(prMergeFact({ ...base, status: { mergeConflicts: false, isMergeable: true, behindBaseBy: 0 } })).toEqual({ text: "Ready to merge", tone: "success" });
    expect(prMergeFact({ ...base, checksFailing: true, status: { mergeConflicts: false, isMergeable: true, behindBaseBy: 0 } })?.text).toBe("No conflicts");
    // Before the status loads, the PR list's conflict flag still speaks.
    expect(prMergeFact({ ...base, status: null, mergeConflicts: true })?.text).toBe("Conflicts with main");
    expect(prMergeFact({ ...base, status: null })).toBeNull();
  });
});

describe("splitLanePrs", () => {
  it("puts the newest open PR up front and the rest behind the disclosure", () => {
    const merged = pr({ key: "m", number: 1, state: "merged", createdAt: at(5000) });
    const open = pr({ key: "o", number: 2, state: "open", createdAt: at(100) });
    const closed = pr({ key: "c", number: 3, state: "closed", createdAt: at(50) });
    expect(splitLanePrs([merged, open, closed])).toEqual({ current: open, earlier: [closed, merged] });
    expect(splitLanePrs([merged, closed])).toEqual({ current: closed, earlier: [merged] });
    expect(splitLanePrs([])).toEqual({ current: null, earlier: [] });
  });
});

describe("laneStatusItems", () => {
  const status = { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false };
  const upstream = { hasUpstream: true, upstreamState: "tracking" as const, upstreamRef: "origin/x", ahead: 0, behind: 0, diverged: false, recommendedAction: "none" as const };

  it("reads a lane's base counts, changes and remote state", () => {
    const items = laneStatusItems({
      lane: { laneType: "worktree", status: { ...status, ahead: 3, behind: 2, dirty: true, changedFileCount: 1 } },
      baseLabel: "main",
      upstream: { ...upstream, ahead: 1, behind: 4 },
    });
    expect(items.map((item) => item.text)).toEqual(["3 ahead", "2 behind main", "1 uncommitted change", "1 to push, 4 to pull"]);
  });

  it("says where the lane is ahead of when it is not behind, and when it is not published", () => {
    const items = laneStatusItems({
      lane: { laneType: "worktree", status: { ...status, ahead: 3 } },
      baseLabel: "main",
      upstream: { ...upstream, hasUpstream: false, upstreamState: "none" as any },
    });
    expect(items.map((item) => item.text)).toEqual(["3 ahead of main", "Not published"]);
  });

  it("reads 'Up to date' when there is nothing to say, and skips base counts on the primary lane", () => {
    expect(laneStatusItems({ lane: { laneType: "worktree", status }, baseLabel: "main", upstream }).map((item) => item.text))
      .toEqual(["Up to date"]);
    expect(laneStatusItems({ lane: { laneType: "primary", status: { ...status, behind: 9 } }, baseLabel: "main", upstream: null }).map((item) => item.text))
      .toEqual(["Clean"]);
  });
});

describe("laneCreatedBy", () => {
  it("is the first chat that started within minutes of the lane", () => {
    const lane = { createdAt: at(600), laneType: "worktree" } as Pick<LaneSummary, "createdAt" | "laneType">;
    const sessions = [
      { sessionId: "late", provider: "codex", startedAt: at(300), title: null },
      { sessionId: "first", provider: "claude", startedAt: at(599), title: "Kickoff" },
    ];
    expect(laneCreatedBy(lane, sessions)?.sessionId).toBe("first");
    expect(laneCreatedBy(lane, [sessions[0]!])).toBeNull();
    expect(laneCreatedBy({ ...lane, laneType: "primary" }, sessions)).toBeNull();
  });
});

describe("laneOverviewSections", () => {
  const empty = { prs: [], chatCount: 0, hasParent: false, childCount: 0, livePrFileCount: 0, laneCommitCount: 0 };

  it("hides every section with nothing in it", () => {
    expect(laneOverviewSections(empty)).toEqual({ pr: false, chats: false, stack: false, changes: null });
  });

  it("shows the open PR's files over the lane's commits, and commits otherwise", () => {
    const open = pr({ state: "open" });
    expect(laneOverviewSections({ ...empty, prs: [open], livePrFileCount: 4, laneCommitCount: 2 }).changes).toBe("pr-files");
    expect(laneOverviewSections({ ...empty, prs: [open], livePrFileCount: 0, laneCommitCount: 2 }).changes).toBe("commits");
    expect(laneOverviewSections({ ...empty, prs: [pr({ state: "merged" })], livePrFileCount: 4, laneCommitCount: 2 }).changes).toBe("commits");
    expect(laneOverviewSections({ ...empty, chatCount: 1, childCount: 1 })).toMatchObject({ chats: true, stack: true });
  });
});
