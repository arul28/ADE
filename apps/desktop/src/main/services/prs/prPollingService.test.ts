import { describe, expect, it, vi } from "vitest";
import { createPrPollingService } from "./prPollingService";
import type { PrSummary } from "../../../shared/types/prs";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function makePr(over: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    projectId: "proj-1",
    laneId: "lane-1",
    githubPrNumber: 7,
    githubUrl: "https://github.com/arul/ADE/pull/7",
    title: "Lane story",
    state: "open",
    baseBranch: "main",
    headBranch: "ade/lane-1",
    headSha: "sha-first",
    checksStatus: "pending",
    reviewStatus: "none",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...over,
  } as PrSummary;
}

/** Drives the poller through explicit ticks with a scripted PR snapshot. */
function createHarness(snapshots: PrSummary[][]) {
  const records: Array<{ kind: string; ref: string }> = [];
  let index = 0;
  const prService = {
    listAll: () => snapshots[Math.min(index, snapshots.length - 1)] ?? [],
    refresh: vi.fn(async () => {}),
    getHotRefreshPrIds: () => [],
    getHotRefreshDelayMs: () => null,
    discoverLanePullRequests: vi.fn(async () => []),
  } as never;

  const service = createPrPollingService({
    logger,
    prService,
    projectConfigService: { get: () => ({ effective: { github: {} } }) } as never,
    onEvent: () => {},
    getLaneEventsService: () => ({
      record: async (input: { kind: string; ref: string | null }) => {
        records.push({ kind: input.kind, ref: input.ref ?? "" });
        return null;
      },
    }) as never,
  });

  return {
    service,
    records,
    async tick(nextIndex: number) {
      index = nextIndex;
      service.poke();
      await vi.advanceTimersByTimeAsync(1);
      // The record() calls are fired without await inside the poller.
      await Promise.resolve();
    },
  };
}

describe("prPollingService lane story refs", () => {
  it("gives every push its own checks and review cycle in the dedupe ref", async () => {
    vi.useFakeTimers();
    try {
      const { service, records, tick } = createHarness([
        [makePr()],
        [makePr({ checksStatus: "failing", reviewStatus: "changes_requested" })],
        // A new push: same statuses, new head — a genuinely new CI cycle.
        [makePr({ headSha: "sha-second", checksStatus: "pending", reviewStatus: "requested" })],
        [makePr({ headSha: "sha-second", checksStatus: "failing", reviewStatus: "changes_requested" })],
      ]);

      await tick(0); // initialize
      await tick(1);
      await tick(2);
      await tick(3);

      expect(records.filter((r) => r.kind === "pr_checks").map((r) => r.ref)).toEqual([
        "pr-1:failing:sha-first",
        "pr-1:pending:sha-second",
        "pr-1:failing:sha-second",
      ]);
      expect(records.filter((r) => r.kind === "pr_review").map((r) => r.ref)).toEqual([
        "pr-1:changes_requested:sha-first",
        "pr-1:requested:sha-second",
        "pr-1:changes_requested:sha-second",
      ]);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
