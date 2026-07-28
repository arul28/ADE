import { describe, expect, it, vi } from "vitest";
import type {
  AgentChatSessionSummary,
  PrActionRun,
  PrCheck,
  PrSummary,
} from "../../../shared/types";
import {
  buildPrCiCard,
  buildPrConflictCard,
  buildPrMergeReadyCard,
  buildPrReviewCard,
  emitPrCardsForChange,
  selectPrCardSession,
} from "./prChatCards";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-7",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "ade",
    repoName: "desktop",
    githubPrNumber: 7,
    githubUrl: "https://github.com/ade/desktop/pull/7",
    githubNodeId: null,
    title: "Make checks useful",
    state: "open",
    baseBranch: "main",
    headBranch: "feature",
    checksStatus: "pending",
    reviewStatus: "approved",
    additions: 10,
    deletions: 2,
    headSha: "abc123",
    lastSyncedAt: null,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T11:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<PrActionRun> = {}): PrActionRun {
  return {
    id: 99,
    name: "CI",
    status: "in_progress",
    conclusion: null,
    headSha: "abc123",
    htmlUrl: "https://github.com/ade/desktop/actions/runs/99",
    createdAt: "2026-07-27T11:00:00.000Z",
    updatedAt: "2026-07-27T11:02:00.000Z",
    runAttempt: 2,
    jobs: [
      {
        id: 1,
        name: "lint",
        status: "completed",
        conclusion: "failure",
        startedAt: null,
        completedAt: null,
        steps: [],
      },
      {
        id: 2,
        name: "test",
        status: "in_progress",
        conclusion: null,
        startedAt: null,
        completedAt: null,
        steps: [],
      },
    ],
    ...overrides,
  };
}

function check(name: string): PrCheck {
  return {
    name,
    status: "completed",
    conclusion: "success",
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
  };
}

function session(
  sessionId: string,
  lastActivityAt: string,
  overrides: Partial<AgentChatSessionSummary> = {},
): AgentChatSessionSummary {
  return {
    sessionId,
    laneId: "lane-1",
    provider: "codex",
    model: "gpt-5",
    status: "idle",
    startedAt: lastActivityAt,
    endedAt: null,
    lastActivityAt,
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...overrides,
  };
}

describe("PR chat cards", () => {
  it("selects the most recently active non-archived Work chat", () => {
    expect(selectPrCardSession([
      session("older", "2026-07-27T10:00:00.000Z"),
      session("personal", "2026-07-27T13:00:00.000Z", { surface: "personal" }),
      session("archived", "2026-07-27T14:00:00.000Z", { archivedAt: "2026-07-27T14:01:00.000Z" }),
      session("newer", "2026-07-27T12:00:00.000Z"),
    ])?.sessionId).toBe("newer");
  });

  it("builds one live CI episode keyed by head and attempt", () => {
    const card = buildPrCiCard({ pr: pr(), runs: [run()], checks: [check("external")] });
    expect(card).toMatchObject({
      cardId: "pr-ci:pr-7:abc123:2",
      variant: "pr_ci",
      state: "live",
      progress: { passed: 0, failed: 1, running: 1, queued: 0 },
      navTarget: { kind: "pr", detailTab: "checks", prNumber: 7 },
    });
    expect(card.rows?.map((row) => row.text)).toEqual(["lint", "test"]);
  });

  it("falls back to check rows when Actions jobs are unavailable", () => {
    const card = buildPrCiCard({
      pr: pr({ checksStatus: "passing" }),
      runs: [],
      checks: [check("Vercel")],
    });
    expect(card.state).toBe("terminal");
    expect(card.progress).toEqual({ passed: 1, failed: 0, running: 0, queued: 0 });
    expect(card.rows?.[0]?.text).toBe("Vercel");
  });

  it("does not report neutral, skipped, or indeterminate checks as passed", () => {
    const card = buildPrCiCard({
      pr: pr({ checksStatus: "passing" }),
      runs: [run({
        status: "completed",
        conclusion: "success",
        jobs: [
          {
            id: 1,
            name: "optional",
            status: "completed",
            conclusion: "skipped",
            startedAt: null,
            completedAt: null,
            steps: [],
          },
          {
            id: 2,
            name: "unknown",
            status: "completed",
            conclusion: null,
            startedAt: null,
            completedAt: null,
            steps: [],
          },
        ],
      })],
      checks: [],
    });
    expect(card.progress).toEqual({ passed: 0, failed: 0, running: 0, queued: 0 });
    expect(card.metrics).toContainEqual({ label: "other", value: "2", tone: "neutral" });
    expect(card.rows).toMatchObject([
      { text: "unknown", icon: "info", detail: "unknown", tone: "neutral" },
      { text: "optional", icon: "skipped", detail: "skipped", tone: "neutral" },
    ]);
  });

  it("summarizes only the newest run for each workflow", () => {
    const card = buildPrCiCard({
      pr: pr({ checksStatus: "passing" }),
      runs: [
        run({
          id: 98,
          createdAt: "2026-07-27T10:00:00.000Z",
          updatedAt: "2026-07-27T10:02:00.000Z",
          jobs: [{
            id: 8,
            name: "old failure",
            status: "completed",
            conclusion: "failure",
            startedAt: null,
            completedAt: null,
            steps: [],
          }],
        }),
        run({
          id: 99,
          createdAt: "2026-07-27T11:00:00.000Z",
          updatedAt: "2026-07-27T11:02:00.000Z",
          status: "completed",
          conclusion: "success",
          jobs: [{
            id: 9,
            name: "current success",
            status: "completed",
            conclusion: "success",
            startedAt: null,
            completedAt: null,
            steps: [],
          }],
        }),
      ],
      checks: [],
    });
    expect(card.progress).toEqual({ passed: 1, failed: 0, running: 0, queued: 0 });
    expect(card.rows?.map((row) => row.text)).toEqual(["current success"]);
  });

  it("gives merge-ready and conflict episodes distinct stable identities", () => {
    expect(buildPrMergeReadyCard(pr()).cardId).toBe("pr-merge-ready:pr-7:abc123");
    expect(buildPrConflictCard({ pr: pr({ behindBaseBy: 4 }), kind: "behind" })).toMatchObject({
      cardId: "pr-conflict:pr-7:abc123:behind",
      variant: "pr_conflict",
      metrics: [{ label: "commits behind", value: "4", tone: "warning" }],
    });
  });

  it("bounds long review bodies before persisting them into a chat transcript", () => {
    const card = buildPrReviewCard({
      pr: pr({ reviewStatus: "changes_requested" }),
      reviews: [{
        reviewer: "review-bot",
        reviewerAvatarUrl: null,
        state: "changes_requested",
        body: "x".repeat(2_000),
        submittedAt: "2026-07-27T12:00:00.000Z",
      }],
      threads: [],
    });
    expect(card.rows?.[0]?.text.length).toBeLessThanOrEqual(480);
    expect(card.rows?.[0]?.text.endsWith("…")).toBe(true);
  });

  it("durably emits all actionable transitions to the lane's newest Work chat", async () => {
    const emitAdeCard = vi.fn().mockResolvedValue(undefined);
    const getActionRuns = vi.fn().mockResolvedValue([run()]);
    const getChecks = vi.fn().mockResolvedValue([check("Vercel")]);
    const count = await emitPrCardsForChange({
      change: {
        pr: pr({
          checksStatus: "failing",
          reviewStatus: "changes_requested",
          mergeConflicts: true,
          behindBaseBy: 3,
        }),
        previousState: "open",
        previousChecksStatus: "pending",
        previousReviewStatus: "requested",
        previousMergeConflicts: false,
        previousBehindBaseBy: 0,
      },
      dataSource: {
        getActionRuns,
        getChecks,
        getReviews: vi.fn().mockResolvedValue([]),
        getReviewThreads: vi.fn().mockResolvedValue([]),
      },
      chat: {
        listSessions: vi.fn().mockResolvedValue([
          session("older", "2026-07-27T10:00:00.000Z"),
          session("newer", "2026-07-27T12:00:00.000Z"),
        ]),
        emitAdeCard,
      },
    });

    expect(count).toBe(4);
    expect(getActionRuns).toHaveBeenCalledWith("pr-7");
    expect(emitAdeCard).toHaveBeenCalledTimes(4);
    expect(emitAdeCard.mock.calls.map(([call]) => call.card.variant)).toEqual([
      "pr_ci",
      "pr_review",
      "pr_conflict",
      "pr_conflict",
    ]);
    expect(emitAdeCard.mock.calls.every(([call]) => call.sessionId === "newer")).toBe(true);
  });

  it("emits a merge-ready episode once when the prior state was not ready", async () => {
    const emitAdeCard = vi.fn().mockResolvedValue(undefined);
    const count = await emitPrCardsForChange({
      change: {
        pr: pr({ checksStatus: "passing", reviewStatus: "approved" }),
        previousState: "open",
        previousChecksStatus: "pending",
        previousReviewStatus: "approved",
        previousMergeConflicts: false,
        previousBehindBaseBy: 0,
      },
      dataSource: {
        getActionRuns: vi.fn().mockResolvedValue([]),
        getChecks: vi.fn().mockResolvedValue([]),
        getReviews: vi.fn().mockResolvedValue([]),
        getReviewThreads: vi.fn().mockResolvedValue([]),
      },
      chat: {
        listSessions: vi.fn().mockResolvedValue([session("chat-1", "2026-07-27T12:00:00.000Z")]),
        emitAdeCard,
      },
    });

    expect(count).toBe(2);
    expect(emitAdeCard.mock.calls.map(([call]) => call.card.variant)).toEqual([
      "pr_ci",
      "pr_merge_ready",
    ]);
  });

  it("does not call chat services for irrelevant PR changes", async () => {
    const listSessions = vi.fn().mockResolvedValue([]);
    const count = await emitPrCardsForChange({
      change: {
        pr: pr({ title: "Only the title changed" }),
        previousState: "open",
        previousChecksStatus: "pending",
        previousReviewStatus: "approved",
        previousMergeConflicts: false,
        previousBehindBaseBy: 0,
      },
      dataSource: {
        getActionRuns: vi.fn().mockResolvedValue([]),
        getChecks: vi.fn().mockResolvedValue([]),
        getReviews: vi.fn().mockResolvedValue([]),
        getReviewThreads: vi.fn().mockResolvedValue([]),
      },
      chat: {
        listSessions,
        emitAdeCard: vi.fn().mockResolvedValue(undefined),
      },
    });
    expect(count).toBe(0);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("waits for conflicts and behind-base state to clear before announcing merge readiness", async () => {
    const emitAdeCard = vi.fn().mockResolvedValue(undefined);
    const base = {
      previousState: "open" as const,
      previousChecksStatus: "passing" as const,
      previousReviewStatus: "approved" as const,
      previousMergeConflicts: true,
      previousBehindBaseBy: 0,
    };
    const common = {
      dataSource: {
        getActionRuns: vi.fn().mockResolvedValue([]),
        getChecks: vi.fn().mockResolvedValue([]),
        getReviews: vi.fn().mockResolvedValue([]),
        getReviewThreads: vi.fn().mockResolvedValue([]),
      },
      chat: {
        listSessions: vi.fn().mockResolvedValue([session("chat-1", "2026-07-27T12:00:00.000Z")]),
        emitAdeCard,
      },
    };

    expect(await emitPrCardsForChange({
      change: { pr: pr({ checksStatus: "passing", mergeConflicts: true }), ...base },
      ...common,
    })).toBe(0);
    expect(await emitPrCardsForChange({
      change: { pr: pr({ checksStatus: "passing", mergeConflicts: false }), ...base },
      ...common,
    })).toBe(1);
    expect(emitAdeCard).toHaveBeenLastCalledWith(expect.objectContaining({
      card: expect.objectContaining({ variant: "pr_merge_ready" }),
    }));
  });

  it("attempts every card even when one durable emit fails", async () => {
    const emitAdeCard = vi.fn()
      .mockRejectedValueOnce(new Error("transcript unavailable"))
      .mockResolvedValue(undefined);
    await expect(emitPrCardsForChange({
      change: {
        pr: pr({ checksStatus: "passing", reviewStatus: "approved" }),
        previousState: "open",
        previousChecksStatus: "pending",
        previousReviewStatus: "approved",
        previousMergeConflicts: false,
        previousBehindBaseBy: 0,
      },
      dataSource: {
        getActionRuns: vi.fn().mockResolvedValue([]),
        getChecks: vi.fn().mockResolvedValue([]),
        getReviews: vi.fn().mockResolvedValue([]),
        getReviewThreads: vi.fn().mockResolvedValue([]),
      },
      chat: {
        listSessions: vi.fn().mockResolvedValue([session("chat-1", "2026-07-27T12:00:00.000Z")]),
        emitAdeCard,
      },
    })).rejects.toThrow(/1 of 2/);
    expect(emitAdeCard).toHaveBeenCalledTimes(2);
  });
});
