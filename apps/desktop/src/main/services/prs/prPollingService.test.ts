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
});
