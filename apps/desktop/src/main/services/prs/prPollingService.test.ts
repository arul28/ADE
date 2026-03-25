import { describe, expect, it, vi, afterEach } from "vitest";
import type { PrSummary } from "../../../shared/types";
import { createPrPollingService } from "./prPollingService";

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
        summary = {
          ...summary,
          updatedAt: new Date(Date.now()).toISOString(),
        };
        return [summary];
      }),
      getHotRefreshDelayMs: () => {
        if (!hotIds.length) return null;
        return 5_000;
      },
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
          summary = {
            ...summary,
            reviewStatus: "requested" as const,
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
          summary = {
            ...summary,
            reviewStatus: "changes_requested" as const,
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
          summary = {
            ...summary,
            checksStatus: "failing" as const,
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

    const notification = events.find((e) => e.type === "pr-notification" && e.kind === "checks_failing");
    expect(notification, "Expected a checks_failing notification to be emitted").toBeTruthy();
    // Title should NOT contain #999 any more
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

    const prService = {
      listAll: () => [summary],
      refresh: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          summary = {
            ...summary,
            checksStatus: "failing" as const,
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
      onEvent: () => {},
      onPullRequestsChanged: (args) => { changedCalls.push(args); },
    });

    service.start();
    // First tick initializes
    await vi.advanceTimersByTimeAsync(12_000);
    expect(changedCalls).toHaveLength(0);

    // Second tick has changed data
    service.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(changedCalls).toHaveLength(1);
    expect(changedCalls[0].changedPrs).toHaveLength(1);
    expect(changedCalls[0].changes[0]).toEqual(expect.objectContaining({
      previousChecksStatus: "passing",
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
          summary = {
            ...summary,
            checksStatus: "failing",
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
