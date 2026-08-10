import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import {
  getPrMergeAutoSettlementState,
  getSessionLifecycleSettings,
  setSessionLifecycleSettings,
} from "../sessions/sessionLifecycleSettings";
import { createPrMergeAutoSettlementService } from "./prMergeAutoSettlementService";
import { createPrPollingService } from "./prPollingService";
import { buildPrSummaryPrompt, createPrSummaryService, parsePrSummaryJson } from "./prSummaryService";
import {
  clearGithubCredentialHealth,
  recordGithubCredentialSuccess,
} from "../github/githubCredentialHealth";

afterEach(() => {
  clearGithubCredentialHealth();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function createSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "proj-1",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: 101,
    githubUrl: "https://github.com/acme/ade/pull/101",
    githubNodeId: "node-101",
    title: "Initial title",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-1",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 3,
    deletions: 1,
    lastSyncedAt: "2026-03-24T00:00:00.000Z",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    ...overrides,
  };
}

async function seedSummaryDb(db: any, prId: string, headSha: string | null) {
  const now = "2026-04-14T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["proj", "/tmp", "ADE", "main", now, now],
  );
  db.run(
    `
      insert into pull_requests(
        id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
        title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
        last_synced_at, created_at, updated_at, head_sha
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      prId, "proj", "lane-1", "arul28", "ADE", 1,
      "https://github.com/arul28/ADE/pull/1", null, "Test", "open", "main", "feat",
      "passing", "approved", 0, 0, now, now, now, headSha,
    ],
  );
}

// ---------------------------------------------------------------------------
// prPollingService — hot refresh, backoff, notifications
// ---------------------------------------------------------------------------

describe("prPollingService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refreshes only hot PRs and ignores updatedAt-only churn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary();
    let hotIds: string[] = [];
    const refreshCalls: Array<{ prId?: string; prIds?: string[] } | undefined> = [];
    const events: Array<{ type: string }> = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async (args?: { prId?: string; prIds?: string[] }) => {
        refreshCalls.push(args);
        summary = { ...summary, updatedAt: new Date(Date.now()).toISOString() };
        return [summary];
      }),
      getHotRefreshDelayMs: () => (hotIds.length ? 5_000 : null),
      getHotRefreshPrIds: () => hotIds,
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(refreshCalls).toEqual([undefined]);
    expect(events.filter((event) => event.type === "prs-updated")).toHaveLength(1);

    hotIds = ["pr-1"];
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls[1]).toEqual({ prIds: ["pr-1"] });
    expect(events.filter((event) => event.type === "prs-updated")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refreshCalls[2]).toEqual({ prIds: ["pr-1"] });
    expect(events.filter((event) => event.type === "prs-updated")).toHaveLength(1);
  });

  it("reconciles webhook PRs once without starting a hot-poll window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const summary = createSummary();
    const refresh = vi.fn(async () => [summary]);
    const prService = {
      listAll: () => [summary],
      refresh,
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: vi.fn(),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(refresh).toHaveBeenLastCalledWith();

    service.reconcilePrs(["pr-1"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenLastCalledWith({ prIds: ["pr-1"] });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenLastCalledWith();
  });

  it("uses webhook reconciliation instead of hot polling while the relay is healthy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const summary = createSummary();
    const refresh = vi.fn(async () => [summary]);
    const prService = {
      listAll: () => [summary],
      refresh,
      getHotRefreshDelayMs: () => 5_000,
      getHotRefreshPrIds: () => ["pr-1"],
    } as any;
    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      isGithubRelayHealthy: () => true,
      onEvent: vi.fn(),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenLastCalledWith();

    service.poke();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    service.reconcilePrs(["pr-1"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ prIds: ["pr-1"] });

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenLastCalledWith();
  });

  it("does not inherit a global pause when the project-scoped provider returns no pause", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    recordGithubCredentialSuccess({
      source: "gh",
      token: "gho_unrelated_project",
      capabilities: ["read", "write"],
    }, new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "100",
      "x-ratelimit-used": "4900",
      "x-ratelimit-reset": String(Date.parse("2026-03-24T13:00:00.000Z") / 1_000),
      "x-ratelimit-resource": "core",
    }));

    const summary = createSummary();
    const refresh = vi.fn(async () => [summary]);
    const getGithubBackgroundPauseUntilMs = vi.fn(() => null);
    const service = createPrPollingService({
      logger: createLogger() as any,
      prService: {
        listAll: () => [summary],
        refresh,
        getHotRefreshDelayMs: () => null,
        getHotRefreshPrIds: () => [],
      } as any,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      getGithubBackgroundPauseUntilMs,
      onEvent: vi.fn(),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(getGithubBackgroundPauseUntilMs).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("retries a failed relay safety sweep after backoff, then restores the safety cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const summary = createSummary();
    const listAll = () => [summary];
    const refresh = vi.fn(async () => [summary])
      .mockRejectedValueOnce(new Error("safety sweep failed"));
    const service = createPrPollingService({
      logger: createLogger() as any,
      prService: {
        listAll,
        refresh,
        getHotRefreshDelayMs: () => null,
        getHotRefreshPrIds: () => [],
      } as any,
      projectConfigService: {
        get: () => ({ effective: { github: { prPollingIntervalSeconds: 5 } } }),
      } as any,
      isGithubRelayHealthy: () => true,
      onEvent: vi.fn(),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("discovers lane PRs when the local PR cache starts empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let rows: PrSummary[] = [];
    const summary = createSummary({ id: "pr-discovered", githubPrNumber: 134, state: "merged" });
    const events: any[] = [];
    const prService = {
      listAll: () => rows,
      discoverLanePullRequests: vi.fn(async () => {
        rows = [summary];
        return rows;
      }),
      refresh: vi.fn(async () => rows),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(prService.discoverLanePullRequests).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "prs-updated",
      prs: [summary],
    }));
  });

  it("throttles empty-cache discovery to a slow cadence and stays idle-cheap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const events: Array<{ type: string }> = [];
    const prService = {
      listAll: () => [],
      discoverLanePullRequests: vi.fn(async () => []),
      refresh: vi.fn(async () => []),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(prService.discoverLanePullRequests).toHaveBeenCalledTimes(1);

    // Nine more 60s ticks stay inside the 10-minute discovery window: no
    // repeated forced snapshot fetches while the project has no tracked PRs.
    for (let index = 0; index < 9; index += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(prService.discoverLanePullRequests).toHaveBeenCalledTimes(1);

    // The tick that crosses the 10-minute mark discovers again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prService.discoverLanePullRequests).toHaveBeenCalledTimes(2);

    // The empty path never runs a tracked-PR refresh and emits a single
    // empty prs-updated event, not one per tick.
    expect(prService.refresh).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "prs-updated")).toHaveLength(1);
  });

  it("does not re-emit opened notifications after a transient empty poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const summary = createSummary({ title: "Tracked PR", state: "open" });
    let rows: PrSummary[] = [summary];
    const events: any[] = [];

    const prService = {
      listAll: () => rows,
      discoverLanePullRequests: vi.fn(async () => rows),
      refresh: vi.fn(async () => rows),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);

    rows = [];
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    rows = [summary];
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.filter((event) => event.type === "pr-notification" && event.kind === "opened")).toHaveLength(0);
    expect(events.filter((event) => event.type === "prs-updated").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps rate-limit backoff ahead of hot wakeups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const summary = createSummary();
    let hotIds: string[] = [];
    let calls = 0;

    const refresh = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("rate limited") as Error & { rateLimitResetAtMs?: number };
        error.rateLimitResetAtMs = Date.now() + 20_000;
        throw error;
      }
      return [summary];
    });

    const prService = {
      listAll: () => [summary],
      refresh,
      getHotRefreshDelayMs: () => (hotIds.length ? 5_000 : null),
      getHotRefreshPrIds: () => hotIds,
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: { github: { prPollingIntervalSeconds: 5 } } }) } as any,
      onEvent: () => {},
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    hotIds = ["pr-1"];
    service.poke();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ prIds: ["pr-1"] });
  });

  it("emits review_requested notification with generic messaging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Add feature",
      headBranch: "feature/add",
      checksStatus: "passing",
      reviewStatus: "none",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, reviewStatus: "requested" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "review_requested",
      title: "Review requested",
      message: "This pull request is waiting on an approving review.",
      prTitle: "Add feature",
      repoOwner: "acme",
      repoName: "ade",
      baseBranch: "main",
      headBranch: "feature/add",
    }));
  });

  it("emits changes_requested notification with generic messaging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Refactor module",
      headBranch: "refactor/module",
      checksStatus: "passing",
      reviewStatus: "requested",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, reviewStatus: "changes_requested" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "changes_requested",
      title: "Changes requested",
      message: "A reviewer requested changes before this pull request can merge.",
      prTitle: "Refactor module",
      repoOwner: "acme",
      repoName: "ade",
    }));
  });

  it("emits merge_ready notification when checks pass and review is approved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Ready PR",
      headBranch: "feature/ready",
      checksStatus: "pending",
      reviewStatus: "approved",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "passing" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "merge_ready",
      title: "Checks passing & approved",
      message: expect.stringContaining("Required checks are passing"),
      prTitle: "Ready PR",
      repoOwner: "acme",
      repoName: "ade",
      baseBranch: "main",
      headBranch: "feature/ready",
    }));
  });

  it("does not announce merge readiness while the PR is conflicted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Conflicted PR",
      checksStatus: "pending",
      reviewStatus: "approved",
      mergeConflicts: true,
    });
    let refreshCount = 0;
    const events: any[] = [];
    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = {
            ...summary,
            checksStatus: "passing" as const,
            updatedAt: new Date(Date.now()).toISOString(),
          };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;
    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "merge_ready",
    }));
  });

  it("notification title no longer includes the PR number", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      githubPrNumber: 999,
      checksStatus: "passing",
      reviewStatus: "none",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "failing" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    const notification = events.find((e) => e.type === "pr-notification" && e.kind === "checks_failing");
    expect(notification, "Expected a checks_failing notification to be emitted").toBeTruthy();
    expect(notification.title).not.toContain("#999");
    expect(notification.title).toBe("Checks failing");
  });

  it("includes onPullRequestsChanged hook with changed PRs details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      checksStatus: "passing",
      reviewStatus: "approved",
    });
    let refreshCount = 0;
    const changedCalls: any[] = [];
    const snapshotCalls: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "failing" as const, updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: () => {},
      onPullRequestsSnapshot: (args) => { snapshotCalls.push(args); },
      onPullRequestsChanged: (args) => { changedCalls.push(args); },
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(changedCalls).toHaveLength(0);
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0].prs).toEqual([summary]);

    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(changedCalls).toHaveLength(1);
    expect(snapshotCalls).toHaveLength(2);
    expect(changedCalls[0].changedPrs).toHaveLength(1);
    expect(changedCalls[0].changes[0]).toEqual(expect.objectContaining({
      previousChecksStatus: "passing",
      previousMergeConflicts: null,
      previousBehindBaseBy: null,
    }));
    expect(changedCalls[0].changes[0].pr.checksStatus).toBe("failing");
  });

  it("emits informative PR notifications with PR metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let summary = createSummary({
      title: "Fix lanes tab",
      headBranch: "fix-lanes-tab",
      checksStatus: "passing",
      reviewStatus: "approved",
    });
    let refreshCount = 0;
    const events: any[] = [];

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = { ...summary, checksStatus: "failing", updatedAt: new Date(Date.now()).toISOString() };
        }
        return [summary];
      }),
      getHotRefreshDelayMs: () => null,
      getHotRefreshPrIds: () => [],
    } as any;

    const service = createPrPollingService({
      logger: createLogger() as any,
      prService,
      projectConfigService: { get: () => ({ effective: {} }) } as any,
      onEvent: (event) => events.push(event),
    });

    service.start();
    await vi.advanceTimersByTimeAsync(12_000);
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContainEqual(expect.objectContaining({
      type: "pr-notification",
      kind: "checks_failing",
      title: "Checks failing",
      prTitle: "Fix lanes tab",
      repoOwner: "acme",
      repoName: "ade",
      baseBranch: "main",
      headBranch: "fix-lanes-tab",
      message: "One or more required CI checks failed on this pull request.",
    }));
  });
});

/**
 * Settlement resolves declared sessions by id and swept sessions through the
 * paged listing. Harnesses declare one list; this derives the lookup from it.
 */
function withSessionLookup<T extends { list: () => Array<{ id: string }> }>(service: T) {
  return {
    ...service,
    get: (sessionId: string) => service.list().find((session) => session.id === sessionId) ?? null,
  };
}

describe("prMergeAutoSettlementService", () => {
  function createMemoryDb() {
    const values = new Map<string, unknown>();
    return {
      getJson: <T>(key: string): T | null => values.has(key) ? values.get(key) as T : null,
      setJson: (key: string, value: unknown): void => { values.set(key, value); },
    };
  }

  it("settles lane agent sessions even when a merge has settlement blockers", async () => {
    const db = createMemoryDb();
    const settledSessionIds = new Set<string>();
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => {
      ids.forEach((id) => settledSessionIds.add(id));
      return ids;
    });
    const emitEvent = vi.fn();
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: withSessionLookup({
        list: vi.fn(() => [
          {
            laneId: "lane-1",
            id: "chat-ready",
            toolType: "codex-chat",
            archivedAt: null,
            settledAt: settledSessionIds.has("chat-ready") ? "2026-03-24T12:01:05.000Z" : null,
          },
          {
            laneId: "lane-1",
            id: "cli-blocked",
            toolType: "codex",
            archivedAt: null,
            settledAt: settledSessionIds.has("cli-blocked") ? "2026-03-24T12:01:05.000Z" : null,
          },
          {
            laneId: "lane-1",
            id: "raw-shell",
            toolType: "shell",
            archivedAt: null,
            settledAt: settledSessionIds.has("raw-shell") ? "2026-03-24T12:01:05.000Z" : null,
          },
        ]),
        get: vi.fn(() => null),
        settleSessionsWithOutcome,
      }) as any,
      emitEvent,
    });
    const openPr = createSummary({ state: "open" });

    await service.processSnapshot({
      prs: [openPr],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    expect(settleSessionsWithOutcome).not.toHaveBeenCalled();

    const mergedPr = createSummary({
      state: "merged",
      mergedAt: "2026-03-24T12:01:00.000Z",
    });
    await service.processSnapshot({
      prs: [mergedPr],
      polledAt: "2026-03-24T12:01:05.000Z",
    });

    expect(settleSessionsWithOutcome).toHaveBeenCalledWith(
      ["chat-ready"],
      "PR #101 merged",
      "2026-03-24T12:01:05.000Z",
      "pr_merge",
    );
    expect(settleSessionsWithOutcome).toHaveBeenCalledWith(
      ["cli-blocked"],
      "PR #101 merged",
      "2026-03-24T12:01:05.000Z",
      "pr_merge",
    );
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "pr-sessions-auto-settled",
      prId: "pr-1",
      settledSessionIds: ["chat-ready", "cli-blocked"],
      settledCount: 2,
    }));

    await service.processSnapshot({
      prs: [mergedPr],
      polledAt: "2026-03-24T12:02:00.000Z",
    });
    expect(settleSessionsWithOutcome).toHaveBeenCalledTimes(2);
  });

  it("stops the merged session's machinery before filing it", async () => {
    // This path deliberately bypasses the settlement blockers, so it is the
    // one most likely to file a session that is still running something. Before
    // teardown reached it, the merged lane's monitors kept polling and woke the
    // thread hours after the PR had landed.
    const db = createMemoryDb();
    const order: string[] = [];
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => {
      order.push("settle");
      return ids;
    });
    const stopBackgroundWork = vi.fn(async () => {
      order.push("stop");
      return { stopped: 1, skippedActiveTurn: false };
    });
    const rows = [{ id: "chat-live", toolType: "claude-chat", archivedAt: null, settledAt: null }];
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: {
        list: vi.fn(() => rows),
        get: vi.fn((id: string) => rows.find((row) => row.id === id) ?? null),
        settleSessionsWithOutcome,
      } as any,
      agentChatService: {
        stopBackgroundWork,
      } as any,
      emitEvent: vi.fn(),
    });

    await service.processSnapshot({
      prs: [createSummary({ state: "open" })],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    await service.processSnapshot({
      prs: [createSummary({ state: "merged", mergedAt: "2026-03-24T12:01:00.000Z" })],
      polledAt: "2026-03-24T12:01:30.000Z",
    });

    expect(stopBackgroundWork).toHaveBeenCalledWith({ sessionId: "chat-live" });
    expect(order).toEqual(["stop", "settle"]);
  });

  it("does not re-settle after reactivation, but settles for a later PR", async () => {
    const db = createMemoryDb();
    let settled = false;
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => {
      settled = true;
      return ids;
    });
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: withSessionLookup({
        list: vi.fn(() => [{
          laneId: "lane-1",
          id: "chat-waiting",
          toolType: "claude-chat",
          archivedAt: null,
          settledAt: settled ? "2026-03-24T12:01:05.000Z" : null,
        }]),
        get: vi.fn(() => null),
        settleSessionsWithOutcome,
      }) as any,
      emitEvent: vi.fn(),
    });
    const openPr = createSummary({
      state: "open",
      githubPrNumber: 101,
      chatSessionIds: ["chat-waiting"],
    });
    const openSecondPr = createSummary({
      id: "pr-2",
      githubPrNumber: 202,
      state: "open",
      chatSessionIds: ["chat-waiting"],
    });
    const mergedPr = createSummary({
      state: "merged",
      mergedAt: "2026-03-24T12:01:00.000Z",
      chatSessionIds: ["chat-waiting"],
    });
    const mergedSecondPr = {
      ...openSecondPr,
      state: "merged" as const,
      mergedAt: "2026-03-24T12:03:00.000Z",
    };

    await service.processSnapshot({
      prs: [openPr, openSecondPr],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    await service.processSnapshot({
      prs: [mergedPr, openSecondPr],
      polledAt: "2026-03-24T12:01:05.000Z",
    });

    expect(settleSessionsWithOutcome).toHaveBeenCalledTimes(1);
    expect(settleSessionsWithOutcome).toHaveBeenLastCalledWith(
      ["chat-waiting"],
      "PR #101 merged",
      "2026-03-24T12:01:05.000Z",
      "pr_merge",
    );
    expect(getPrMergeAutoSettlementState(db as any)?.handledPrIds).toEqual(["pr-1"]);

    // The user reactivates the chat. The old merged PR is already handled, so
    // it must not immediately file the chat again.
    settled = false;
    await service.processSnapshot({
      prs: [mergedPr, openSecondPr],
      polledAt: "2026-03-24T12:02:00.000Z",
    });
    expect(settleSessionsWithOutcome).toHaveBeenCalledTimes(1);

    // A distinct PR on the same lane gets its own one-shot settlement.
    await service.processSnapshot({
      prs: [mergedPr, mergedSecondPr],
      polledAt: "2026-03-24T12:03:05.000Z",
    });

    expect(settleSessionsWithOutcome).toHaveBeenLastCalledWith(
      ["chat-waiting"],
      "PR #202 merged",
      "2026-03-24T12:03:05.000Z",
      "pr_merge",
    );
    expect(settleSessionsWithOutcome).toHaveBeenCalledTimes(2);
    expect(getPrMergeAutoSettlementState(db as any)?.handledPrIds).toEqual(["pr-1", "pr-2"]);
  });

  it("baselines old merges and only settles merges observed after re-enabling", async () => {
    const db = createMemoryDb();
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => ids);
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: withSessionLookup({
        list: vi.fn(() => [{
          id: "chat-ready",
          toolType: "claude-chat",
          archivedAt: null,
          settledAt: null,
        }]),
        get: vi.fn(() => null),
        settleSessionsWithOutcome,
      }) as any,
      emitEvent: vi.fn(),
    });
    const oldMerge = createSummary({
      state: "merged",
      mergedAt: "2026-03-24T10:00:00.000Z",
    });

    expect(getSessionLifecycleSettings(db as any)).toEqual({
      autoSettleLaneSessionsOnPrMerge: true,
    });
    await service.processSnapshot({
      prs: [oldMerge],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    expect(settleSessionsWithOutcome).not.toHaveBeenCalled();
    expect(getPrMergeAutoSettlementState(db as any)?.handledPrIds).toEqual(["pr-1"]);

    setSessionLifecycleSettings({
      db: db as any,
      settings: { autoSettleLaneSessionsOnPrMerge: false },
      currentPrs: [oldMerge],
      now: "2026-03-24T12:01:00.000Z",
    });
    setSessionLifecycleSettings({
      db: db as any,
      settings: { autoSettleLaneSessionsOnPrMerge: true },
      currentPrs: [oldMerge],
      now: "2026-03-24T12:02:00.000Z",
    });
    const enabledState = getPrMergeAutoSettlementState(db as any);
    setSessionLifecycleSettings({
      db: db as any,
      settings: { autoSettleLaneSessionsOnPrMerge: true },
      currentPrs: [oldMerge, createSummary({
        id: "merge-during-retry",
        state: "merged",
        mergedAt: "2026-03-24T12:02:30.000Z",
      })],
      now: "2026-03-24T12:02:45.000Z",
    });
    expect(getPrMergeAutoSettlementState(db as any)).toEqual(enabledState);

    const futureMerge = createSummary({
      id: "pr-2",
      githubPrNumber: 202,
      state: "merged",
      mergedAt: "2026-03-24T12:03:00.000Z",
    });
    await service.processSnapshot({
      prs: [oldMerge, futureMerge],
      polledAt: "2026-03-24T12:03:05.000Z",
    });
    expect(settleSessionsWithOutcome).toHaveBeenCalledWith(
      ["chat-ready"],
      "PR #202 merged",
      "2026-03-24T12:03:05.000Z",
      "pr_merge",
    );
  });

  it("settles only the chats explicitly linked to a merged PR", async () => {
    const db = createMemoryDb();
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => ids);
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: withSessionLookup({
        list: vi.fn(() => [
          { laneId: "lane-1", id: "chat-owned", toolType: "codex-chat", archivedAt: null, settledAt: null },
          { laneId: "lane-1", id: "chat-other", toolType: "codex-chat", archivedAt: null, settledAt: null },
        ]),
        get: vi.fn(() => null),
        settleSessionsWithOutcome,
      }) as any,
      emitEvent: vi.fn(),
    });
    const openPr = createSummary({ state: "open" });
    await service.processSnapshot({ prs: [openPr], polledAt: "2026-03-24T12:00:00.000Z" });

    const mergedPr = createSummary({
      state: "merged",
      mergedAt: "2026-03-24T12:01:00.000Z",
      chatSessionIds: ["chat-owned"],
    });
    await service.processSnapshot({ prs: [mergedPr], polledAt: "2026-03-24T12:01:05.000Z" });

    expect(settleSessionsWithOutcome).toHaveBeenCalledWith(
      ["chat-owned"],
      "PR #101 merged",
      "2026-03-24T12:01:05.000Z",
      "pr_merge",
    );
  });

  it("settles a PR that was already merged when first seen, but announces nothing", async () => {
    // The machine-switch bug. Point the project tab at another machine and that
    // machine reconciles, backfilling rows for PRs it had never stored. Every
    // one arrives already merged, with a freshly-minted `randomUUID()` id that
    // no `handledPrIds` list can match and a `mergedAt` comfortably after that
    // machine's `enabledSince` — so each looked like breaking news, and the user
    // got a stack of toasts about PRs that landed days ago.
    //
    // Filing the sessions is still right; announcing is not.
    const db = createMemoryDb();
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => ids);
    const emitEvent = vi.fn();
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: withSessionLookup({
        list: vi.fn(() => [{
          id: "chat-ready",
          toolType: "claude-chat",
          archivedAt: null,
          settledAt: null,
        }]),
        get: vi.fn(() => null),
        settleSessionsWithOutcome,
      }) as any,
      emitEvent,
    });

    // A first snapshot establishes the baseline state, as any running app has.
    await service.processSnapshot({
      prs: [createSummary({ id: "pr-existing", githubPrNumber: 1, state: "open" })],
      polledAt: "2026-03-24T12:00:00.000Z",
    });

    // Now the tab switches machines and a batch of long-merged PRs appears for
    // the first time — merged AFTER enabledSince, so the old guard let them all
    // through.
    const historic = [
      createSummary({
        id: "pr-977", githubPrNumber: 977, state: "merged", mergedAt: "2026-03-24T12:00:30.000Z",
      }),
      createSummary({
        id: "pr-983", githubPrNumber: 983, state: "merged", mergedAt: "2026-03-24T12:00:40.000Z",
      }),
    ];
    await service.processSnapshot({
      prs: historic,
      polledAt: "2026-03-24T12:05:00.000Z",
    });

    expect(settleSessionsWithOutcome).toHaveBeenCalledTimes(2);
    expect(emitEvent).not.toHaveBeenCalled();

    // And a merge we actually watch still announces itself, so the fix does not
    // simply mute the feature.
    const watched = createSummary({
      id: "pr-991", githubPrNumber: 991, state: "open",
    });
    await service.processSnapshot({
      prs: [...historic, watched],
      polledAt: "2026-03-24T12:06:00.000Z",
    });
    await service.processSnapshot({
      prs: [...historic, { ...watched, state: "merged", mergedAt: "2026-03-24T12:07:00.000Z" }],
      polledAt: "2026-03-24T12:07:05.000Z",
    });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "pr-sessions-auto-settled",
      prNumber: 991,
    }));
  });

  it("honors disabling auto-settle before a merged PR is processed", async () => {
    const db = createMemoryDb();
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => ids);
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: withSessionLookup({
        list: vi.fn(() => [{
          id: "chat-ready",
          toolType: "codex-chat",
          archivedAt: null,
          settledAt: null,
        }]),
        get: vi.fn(() => null),
        settleSessionsWithOutcome,
      }) as any,
      emitEvent: vi.fn(),
    });
    const openPr = createSummary({ state: "open" });
    await service.processSnapshot({
      prs: [openPr],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    const mergedPr = createSummary({
      state: "merged",
      mergedAt: "2026-03-24T12:01:00.000Z",
    });
    setSessionLifecycleSettings({
      db: db as any,
      settings: { autoSettleLaneSessionsOnPrMerge: false },
      currentPrs: [openPr],
      now: "2026-03-24T12:01:00.000Z",
    });
    await service.processSnapshot({
      prs: [mergedPr],
      polledAt: "2026-03-24T12:01:05.000Z",
    });

    expect(settleSessionsWithOutcome).not.toHaveBeenCalled();
    expect(getSessionLifecycleSettings(db as any).autoSettleLaneSessionsOnPrMerge).toBe(false);
    expect(getPrMergeAutoSettlementState(db as any)).toEqual({
      enabledSince: null,
      handledPrIds: [],
    });
  });

  /**
   * A merged PR with no declared chat links used to sweep the whole lane, and
   * that sweep deliberately bypasses settlement blockers — so one merge could
   * file chats that belonged to a different, still-open PR.
   */
  function createLaneSweepService(overrides: {
    sessions: Array<{ id: string; toolType: string; laneId?: string }>;
    /** Sessions the lane listing does not return (e.g. past its page size). */
    omitFromListing?: string[];
  }) {
    const db = createMemoryDb();
    const settledSessionIds = new Set<string>();
    const settleSessionsWithOutcome = vi.fn((ids: string[]) => {
      ids.forEach((id) => settledSessionIds.add(id));
      return ids;
    });
    const rowFor = (session: { id: string; toolType: string; laneId?: string }) => ({
      laneId: "lane-1",
      ...session,
      archivedAt: null,
      settledAt: settledSessionIds.has(session.id) ? "2026-03-24T12:01:05.000Z" : null,
    });
    const service = createPrMergeAutoSettlementService({
      db: db as any,
      sessionService: {
        get: vi.fn((sessionId: string) => {
          const match = overrides.sessions.find((session) => session.id === sessionId);
          return match ? rowFor(match) : null;
        }),
        // Deliberately excludes declared sessions: a lane page can miss them,
        // and the linked path must not depend on this listing.
        list: vi.fn(() => overrides.sessions
          .filter((session) => !(overrides.omitFromListing ?? []).includes(session.id))
          .map(rowFor)),
        settleSessionsWithOutcome,
      } as any,
      emitEvent: vi.fn(),
    });
    return { service, settleSessionsWithOutcome };
  }

  it("does not settle sessions another open PR in the lane claims", async () => {
    const { service, settleSessionsWithOutcome } = createLaneSweepService({
      sessions: [
        { laneId: "lane-1", id: "chat-merged-work", toolType: "codex-chat" },
        { laneId: "lane-1", id: "chat-other-pr", toolType: "codex-chat" },
      ],
    });
    // The merged PR declares nothing (created via `gh pr create`); the sibling
    // PR is still open and explicitly owns `chat-other-pr`.
    const unlinkedPr = createSummary({ id: "pr-unlinked", state: "open" });
    const siblingPr = createSummary({
      id: "pr-sibling",
      githubPrNumber: 102,
      state: "merged",
      mergedAt: "2026-03-24T11:00:00.000Z",
      chatSessionIds: ["chat-other-pr"],
    });

    await service.processSnapshot({
      prs: [unlinkedPr, siblingPr],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    await service.processSnapshot({
      prs: [
        { ...unlinkedPr, state: "merged", mergedAt: "2026-03-24T12:01:00.000Z" },
        siblingPr,
      ],
      polledAt: "2026-03-24T12:01:05.000Z",
    });

    expect(settleSessionsWithOutcome).toHaveBeenCalledWith(
      ["chat-merged-work"],
      "PR #101 merged",
      "2026-03-24T12:01:05.000Z",
      "pr_merge",
    );
    expect(settleSessionsWithOutcome).not.toHaveBeenCalledWith(
      ["chat-other-pr"],
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("settles nothing on an unlinked merge while another PR in the lane is still live", async () => {
    const { service, settleSessionsWithOutcome } = createLaneSweepService({
      sessions: [{ laneId: "lane-1", id: "chat-ambiguous", toolType: "codex-chat" }],
    });
    const unlinkedPr = createSummary({ id: "pr-unlinked", state: "open" });
    const stillOpenPr = createSummary({ id: "pr-open", githubPrNumber: 102, state: "open" });

    await service.processSnapshot({
      prs: [unlinkedPr, stillOpenPr],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    await service.processSnapshot({
      prs: [
        { ...unlinkedPr, state: "merged", mergedAt: "2026-03-24T12:01:00.000Z" },
        stillOpenPr,
      ],
      polledAt: "2026-03-24T12:01:05.000Z",
    });

    // Ownership is genuinely ambiguous: the open PR's own merge files the lane.
    expect(settleSessionsWithOutcome).not.toHaveBeenCalled();
  });

  it("settles declared sessions beyond the lane listing limit", async () => {
    // The lane listing is paged. A session the PR explicitly named must not be
    // dropped just because a long-lived lane pushed it past that page.
    const { service, settleSessionsWithOutcome } = createLaneSweepService({
      sessions: [{ laneId: "lane-1", id: "chat-past-page", toolType: "codex-chat" }],
      omitFromListing: ["chat-past-page"],
    });
    const linkedPr = createSummary({ state: "open", chatSessionIds: ["chat-past-page"] });

    await service.processSnapshot({ prs: [linkedPr], polledAt: "2026-03-24T12:00:00.000Z" });
    await service.processSnapshot({
      prs: [{ ...linkedPr, state: "merged", mergedAt: "2026-03-24T12:01:00.000Z" }],
      polledAt: "2026-03-24T12:01:05.000Z",
    });

    expect(settleSessionsWithOutcome).toHaveBeenCalledWith(
      ["chat-past-page"],
      "PR #101 merged",
      "2026-03-24T12:01:05.000Z",
      "pr_merge",
    );
  });

  it("still settles exactly the declared sessions when a PR links its chats", async () => {
    const { service, settleSessionsWithOutcome } = createLaneSweepService({
      sessions: [
        { laneId: "lane-1", id: "chat-linked", toolType: "codex-chat" },
        { laneId: "lane-1", id: "chat-unrelated", toolType: "codex-chat" },
      ],
    });
    const linkedPr = createSummary({ state: "open", chatSessionIds: ["chat-linked"] });
    const stillOpenPr = createSummary({ id: "pr-open", githubPrNumber: 102, state: "open" });

    await service.processSnapshot({
      prs: [linkedPr, stillOpenPr],
      polledAt: "2026-03-24T12:00:00.000Z",
    });
    await service.processSnapshot({
      prs: [
        { ...linkedPr, state: "merged", mergedAt: "2026-03-24T12:01:00.000Z" },
        stillOpenPr,
      ],
      polledAt: "2026-03-24T12:01:05.000Z",
    });

    // A declaration is explicit, so a live sibling PR does not suppress it.
    expect(settleSessionsWithOutcome).toHaveBeenCalledTimes(1);
    expect(settleSessionsWithOutcome).toHaveBeenCalledWith(
      ["chat-linked"],
      "PR #101 merged",
      "2026-03-24T12:01:05.000Z",
      "pr_merge",
    );
  });
});

// ---------------------------------------------------------------------------
// prSummaryService — prompt building, JSON parsing, summary cache
// ---------------------------------------------------------------------------

describe("buildPrSummaryPrompt", () => {
  it("includes title, body, file list, unresolved count, and bot summaries", () => {
    const prompt = buildPrSummaryPrompt({
      title: "Add feature",
      body: "Body content",
      changedFiles: [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: null, previousFilename: null },
        { filename: "b.ts", status: "added", additions: 10, deletions: 0, patch: null, previousFilename: null },
      ],
      issueComments: [
        {
          id: "c1",
          author: "greptile-bot",
          authorAvatarUrl: null,
          body: "Looks risky",
          source: "issue",
          url: null,
          path: null,
          line: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      reviews: [
        {
          reviewer: "coderabbitai[bot]",
          reviewerAvatarUrl: null,
          state: "commented",
          body: "Formal bot review body",
          submittedAt: null,
        },
      ],
      unresolvedThreadCount: 3,
    });
    expect(prompt).toContain("Add feature");
    expect(prompt).toContain("Body content");
    expect(prompt).toContain("modified a.ts");
    expect(prompt).toContain("added b.ts");
    expect(prompt).toContain("Unresolved review threads: 3");
    expect(prompt).toContain("@greptile-bot");
  });
});

describe("parsePrSummaryJson", () => {
  it("returns fields when valid JSON provided", () => {
    const result = parsePrSummaryJson(
      '```json\n{"summary":"x","riskAreas":["a"],"reviewerHotspots":["b"],"unresolvedConcerns":[]}\n```',
    );
    expect(result).toEqual({
      summary: "x",
      riskAreas: ["a"],
      reviewerHotspots: ["b"],
      unresolvedConcerns: [],
    });
  });

  it("filters non-string array entries", () => {
    const result = parsePrSummaryJson(
      '{"summary":"s","riskAreas":["ok", 5, null],"reviewerHotspots":[],"unresolvedConcerns":[]}',
    );
    expect(result?.riskAreas).toEqual(["ok"]);
  });

  it("returns null on missing JSON", () => {
    expect(parsePrSummaryJson("no json here")).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parsePrSummaryJson("{ not json }")).toBeNull();
  });
});

describe("createPrSummaryService", () => {
  it("returns null from getSummary when no cache entry exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-sum-get-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      await seedSummaryDb(db, "pr-1", "headA");
      const svc = createPrSummaryService({
        db,
        logger: createLogger() as any,
        projectRoot: root,
        prService: {} as any,
      });
      await expect(svc.getSummary("pr-1")).resolves.toBeNull();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("regenerateSummary caches the result keyed by (prId, headSha) and parses JSON", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-sum-regen-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      await seedSummaryDb(db, "pr-1", "headA");

      const prService = {
        listAll: () => [
          {
            id: "pr-1",
            laneId: "lane-1",
            projectId: "proj",
            repoOwner: "arul28",
            repoName: "ADE",
            githubPrNumber: 1,
            githubUrl: "",
            githubNodeId: null,
            title: "PR title",
            state: "open",
            baseBranch: "main",
            headBranch: "feat",
            checksStatus: "passing",
            reviewStatus: "approved",
            additions: 0,
            deletions: 0,
            lastSyncedAt: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
        getDetail: vi.fn(async () => ({
          prId: "pr-1",
          body: "Detail body",
          labels: [],
          assignees: [],
          requestedReviewers: [],
          author: { login: "arul", avatarUrl: null },
          isDraft: false,
          milestone: null,
          linkedIssues: [],
        })),
        getFiles: vi.fn(async () => [
          { filename: "x.ts", status: "modified", additions: 1, deletions: 0, patch: null, previousFilename: null },
        ]),
        getComments: vi.fn(async () => []),
        getReviewThreads: vi.fn(async () => [
          {
            id: "t1",
            isResolved: false,
            isOutdated: false,
            path: "x.ts",
            line: 1,
            originalLine: 1,
            startLine: 0,
            originalStartLine: 0,
            diffSide: "RIGHT",
            url: null,
            createdAt: null,
            updatedAt: null,
            comments: [],
          },
        ]),
        getReviews: vi.fn(async () => []),
      };

      const aiIntegrationService = {
        draftPrDescription: vi.fn(async () => ({
          text: '{"summary":"ok","riskAreas":["a"],"reviewerHotspots":["b"],"unresolvedConcerns":["c"]}',
          durationMs: 10,
          executedAt: "x",
          model: "m",
          provider: "openai" as const,
          reasoningEffort: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          budgetState: null,
          taskType: "pr_description" as const,
          feature: "pr_descriptions" as const,
        })),
      };

      const svc = createPrSummaryService({
        db,
        logger: createLogger() as any,
        projectRoot: root,
        prService: prService as any,
        aiIntegrationService: aiIntegrationService as any,
      });

      const result = await svc.regenerateSummary("pr-1");
      expect(result.summary).toBe("ok");
      expect(result.riskAreas).toEqual(["a"]);
      expect(result.headSha).toBe("headA");
      expect(aiIntegrationService.draftPrDescription).toHaveBeenCalledTimes(1);

      const cached = await svc.getSummary("pr-1");
      expect(cached?.summary).toBe("ok");
      expect(cached?.headSha).toBe("headA");

      const again = await svc.regenerateSummary("pr-1");
      expect(again.summary).toBe("ok");
      expect(aiIntegrationService.draftPrDescription).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back gracefully when aiIntegrationService is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-prs-sum-fallback-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      await seedSummaryDb(db, "pr-1", "headA");
      const prService = {
        listAll: () => [{ id: "pr-1", title: "t" } as any],
        getDetail: async () => null,
        getFiles: async () => [],
        getComments: async () => [],
        getReviewThreads: async () => [],
        getReviews: async () => [],
      };
      const svc = createPrSummaryService({
        db,
        logger: createLogger() as any,
        projectRoot: root,
        prService: prService as any,
      });
      const result = await svc.regenerateSummary("pr-1");
      expect(result.summary).toMatch(/0 file/);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
