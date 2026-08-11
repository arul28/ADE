import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createDynamicCursorCliModelDescriptor,
  MODEL_REGISTRY,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { openKvDb, type AdeDb } from "../state/kvDb";
import {
  collectAdeDatabaseUsageStats,
  isMeaningfulUsageAction,
  recordUsageInteraction,
  usageActionFromIpcChannel,
  usageActionFromRpcDomain,
  usageClientSurfaceFromPeer,
  usageClientSurfaceFromRpcName,
} from "./usageStatsStore";

const mockState = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  resolveCodexExecutable: vi.fn(),
}));

const requireForTest = createRequire(path.join(process.cwd(), "usage-test.cjs"));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockState.spawn(...args),
  spawnSync: (...args: unknown[]) => mockState.spawnSync(...args),
}));

vi.mock("../ai/codexExecutable", () => ({
  resolveCodexExecutable: (...args: unknown[]) => mockState.resolveCodexExecutable(...args),
}));

import { createUsageTrackingService, _testing } from "./usageTrackingService";
import { tokenPriceSource, _testing as _pricingTesting } from "./usagePricing";
import { encodeActiveDayBits } from "../lanes/laneUsageTombstone";
// Cross-layer on purpose: the daily split is only useful if the renderer's
// chart reducer sees it, so the service test asserts against the real reducer
// rather than a local re-implementation of it. The model module, not the
// component that renders it — this is a main-process test and has no business
// pulling React and the icon set into its module graph.
import {
  buildDayColumns,
  USAGE_CHART_COMBINED_ID,
} from "../../../renderer/components/usage/usageDailyChartModel";
import {
  compareRecentFileCandidates,
  runLedgerScanWithCompleteness,
  sanitizeClaudeProjectPath,
  usageLedgerTranscriptRootExists,
  usageLedgerTranscriptRoots,
} from "./ledgers/localUsageLedgers";
import { providerScanners } from "./usageLedgerWorker";
import type { TokenEntry } from "./ledgers/localUsageLedgers";
import type { CostSnapshot } from "../../../shared/types";

const {
  aggregateCosts,
  bucketDaily7d,
  localDayKey,
  makeDailySkeleton,
  dateIntersectsRange,
  scanGithubPullRequestPages,
  calculatePacing,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  isCodexTokenStale,
  isTokenExpiredOrExpiring,
  parseClaudeWindows,
  parseClaudeCliUsage,
  parseCodexRateLimitSnapshot,
  parseCodexRateLimitWindows,
  isUsageSnapshot,
  calculatePacingByProvider,
  buildProviderWindows,
  fetchJsonWithRetry,
  collectAdeUsageStats,
  pollCodexUsage,
  pollCodexViaCliRpc,
  resolveTokenPrice,
  resetDynamicTokenPricingForTest,
  setDynamicTokenPricingForTest,
  discoverClaudeProjectDirs,
  scanClaudeLogs,
  scanCodexLogs,
  scanCursorLogs,
  scanCursorAgentLogs,
  scanOpenClawLogs,
  scanOpenCodeLogs,
  scanDroidLogs,
  scanCopilotLogs,
  scanGeminiLogs,
  findRecentFiles,
  buildCostSnapshots,
} = _testing;

// ── Helpers ──────────────────────────────────────────────────────

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-usage-test-"));
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

function createFakeCodexChild({
  closeCode = 0,
  stdout = "",
  stderr = "",
  stdinError = null,
}: {
  closeCode?: number | null;
  stdout?: string;
  stderr?: string;
  stdinError?: Error | null;
}) {
  const child = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinEmitter = new EventEmitter() as any;
  const written: string[] = [];

  stdinEmitter.write = vi.fn((chunk: string) => {
    written.push(chunk);
    return true;
  });
  stdinEmitter.end = vi.fn(() => {
    queueMicrotask(() => {
      if (stdinError) {
        stdinEmitter.emit("error", stdinError);
        return;
      }
      if (stdout) stdoutEmitter.emit("data", Buffer.from(stdout));
      if (stderr) stderrEmitter.emit("data", Buffer.from(stderr));
      child.emit("close", closeCode);
    });
  });

  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  child.stdin = stdinEmitter;
  child.kill = vi.fn();

  return { child, written, stdinEmitter, stdoutEmitter, stderrEmitter };
}

beforeEach(() => {
  mockState.spawn.mockReset();
  mockState.spawnSync.mockReset();
  mockState.spawnSync.mockReturnValue({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  mockState.resolveCodexExecutable.mockReset();
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
});

// ── calculatePacing ──────────────────────────────────────────────

describe("calculatePacing", () => {
  it("returns on-track for empty windows", () => {
    const result = calculatePacing([]);
    expect(result.status).toBe("on-track");
    expect(result.projectedWeeklyPercent).toBe(0);
    expect(result.weekElapsedPercent).toBe(0);
    expect(result.willLastToReset).toBe(true);
  });

  it("returns ahead status when usage outpaces time", () => {
    const totalWindowMs = 7 * 24 * 60 * 60 * 1000;
    // 50% used with only 40% of the week elapsed -> delta = +10%
    const resetsInMs = totalWindowMs * 0.6;
    const result = calculatePacing([
      {
        provider: "claude",
        windowType: "weekly",
        percentUsed: 50,
        resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
        resetsInMs,
      },
    ]);
    expect(result.deltaPercent).toBeGreaterThan(0);
    expect(result.projectedWeeklyPercent).toBeGreaterThan(90);
    expect(["slightly-ahead", "ahead", "far-ahead"]).toContain(result.status);
  });

  it("returns behind status when usage lags time", () => {
    const totalWindowMs = 7 * 24 * 60 * 60 * 1000;
    // 20% used with 60% of week elapsed -> delta = -40%
    const resetsInMs = totalWindowMs * 0.4;
    const result = calculatePacing([
      {
        provider: "claude",
        windowType: "weekly",
        percentUsed: 20,
        resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
        resetsInMs,
      },
    ]);
    expect(result.deltaPercent).toBeLessThan(0);
    expect(result.willLastToReset).toBe(true);
    expect(["slightly-behind", "behind", "far-behind"]).toContain(result.status);
  });

  it("returns on-track for moderate usage", () => {
    const totalWindowMs = 7 * 24 * 60 * 60 * 1000;
    // 48% used with 50% of the week elapsed -> delta = -2%
    const resetsInMs = totalWindowMs * 0.5;
    const result = calculatePacing([
      {
        provider: "claude",
        windowType: "weekly",
        percentUsed: 48,
        resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
        resetsInMs,
      },
    ]);
    expect(result.status).toBe("on-track");
    expect(Math.abs(result.deltaPercent)).toBeLessThan(4);
  });

  it("computes eta and willLastToReset correctly", () => {
    const totalWindowMs = 7 * 24 * 60 * 60 * 1000;
    // 80% used with 50% of the week elapsed -> will NOT last
    const resetsInMs = totalWindowMs * 0.5;
    const result = calculatePacing([
      {
        provider: "claude",
        windowType: "weekly",
        percentUsed: 80,
        resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
        resetsInMs,
      },
    ]);
    expect(result.etaHours).not.toBeNull();
    expect(result.etaHours!).toBeGreaterThan(0);
    expect(result.willLastToReset).toBe(false);
    expect(result.resetsInHours).toBeGreaterThan(0);
  });

  it("prefers Claude weekly window over Codex", () => {
    const totalWindowMs = 7 * 24 * 60 * 60 * 1000;
    const resetsInMs = totalWindowMs * 0.5;
    const result = calculatePacing([
      {
        provider: "codex",
        windowType: "weekly",
        percentUsed: 10,
        resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
        resetsInMs,
      },
      {
        provider: "claude",
        windowType: "weekly",
        percentUsed: 80,
        resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
        resetsInMs,
      },
    ]);
    // Should use Claude (80% used, 50% elapsed → delta +30 → far-ahead)
    expect(result.deltaPercent).toBeGreaterThan(20);
    expect(result.status).toBe("far-ahead");
  });
});

// ── aggregateCosts ───────────────────────────────────────────────

describe("aggregateCosts", () => {
  it("aggregates token entries into a cost snapshot", () => {
    const now = Date.now();
    const entries = [
      {
        messageId: "a:1",
        model: "claude-3-5-sonnet",
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 200,
        timestamp: now - 1000,
      },
      {
        messageId: "b:2",
        model: "claude-3-5-sonnet",
        inputTokens: 2000,
        outputTokens: 1000,
        cachedTokens: 0,
        timestamp: now - 2000,
      },
    ];

    const result = aggregateCosts(entries, "claude");
    expect(result.provider).toBe("claude");
    expect(result.last30dCostUsd).toBeGreaterThan(0);
    expect(result.todayCostUsd).toBeGreaterThan(0);
    expect(result.costUsdByPreset?.today).toBe(result.todayCostUsd);
    expect(result.costUsdByPreset?.["30d"]).toBe(result.last30dCostUsd);
    expect(result.tokenBreakdown["claude-3-5-sonnet"]).toBeDefined();
    expect(result.tokenBreakdown["claude-3-5-sonnet"]!.input).toBe(3000);
    expect(result.tokenBreakdown["claude-3-5-sonnet"]!.output).toBe(1500);
    expect(result.tokenBreakdown["claude-3-5-sonnet"]!.cached).toBe(200);
  });

  it("charges cache read and cache write tokens", () => {
    const now = Date.now();
    const result = aggregateCosts([
      {
        messageId: "cached:1",
        model: "gpt-5.5",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        timestamp: now - 1000,
      },
    ], "codex");

    expect(result.last30dCostUsd).toBe(41.75);
    expect(result.costUsdByPreset?.today).toBe(41.75);
    expect(result.tokenBreakdown["gpt-5.5"]!.cacheWrite).toBe(1_000_000);
  });

  it("excludes entries older than 30 days", () => {
    const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const entries = [
      {
        messageId: "old:1",
        model: "claude-3-5-sonnet",
        inputTokens: 10000,
        outputTokens: 5000,
        cachedTokens: 0,
        timestamp: oldTimestamp,
      },
    ];

    const result = aggregateCosts(entries, "claude");
    expect(result.last30dCostUsd).toBe(0);
    expect(result.todayCostUsd).toBe(0);
  });

  it("separates today cost from 30d cost", () => {
    const now = Date.now();
    const yesterdayMs = now - 25 * 60 * 60 * 1000; // 25h ago
    const entries = [
      {
        messageId: "today:1",
        model: "claude-3-5-sonnet",
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 0,
        timestamp: now - 1000,
      },
      {
        messageId: "yesterday:1",
        model: "claude-3-5-sonnet",
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 0,
        timestamp: yesterdayMs,
      },
    ];

    const result = aggregateCosts(entries, "claude");
    expect(result.last30dCostUsd).toBeGreaterThan(result.todayCostUsd);
    expect(result.todayCostUsd).toBeGreaterThan(0);
    expect(result.costUsdByPreset?.today).toBe(result.todayCostUsd);
    expect(result.costUsdByPreset?.["7d"]).toBe(result.last30dCostUsd);
    expect(result.tokenBreakdownByPreset?.today?.["claude-3-5-sonnet"]?.input).toBe(1000);
    expect(result.tokenBreakdownByPreset?.["7d"]?.["claude-3-5-sonnet"]?.input).toBe(2000);
    expect(result.tokenBreakdownByPreset?.["30d"]?.["claude-3-5-sonnet"]?.input).toBe(2000);
  });
});

describe("local daily aggregation", () => {
  it("scopes the ADE and external token split to an exact range", () => {
    const adeDay = new Date(2026, 4, 28, 12, 0, 0, 0);
    const externalDay = new Date(2026, 4, 29, 12, 0, 0, 0);
    const cost = aggregateCosts([
      {
        messageId: "ade-day",
        model: "gpt-5.5",
        originator: "ade_desktop",
        inputTokens: 70,
        outputTokens: 30,
        cachedTokens: 0,
        timestamp: adeDay.getTime(),
      },
      {
        messageId: "external-day",
        model: "gpt-5.5",
        originator: "codex_cli_rs",
        inputTokens: 40,
        outputTokens: 10,
        cachedTokens: 0,
        timestamp: externalDay.getTime(),
      },
    ], "codex");
    const snapshot = {
      windows: [],
      pacing: calculatePacing([]),
      costs: [cost],
      adeCosts: [],
      extraUsage: [],
      lastPolledAt: externalDay.toISOString(),
      errors: [],
    } as any;

    const presetStats = collectAdeUsageStats({
      snapshot,
      args: { preset: "all" },
      nowMs: externalDay.getTime(),
    });
    const exactStats = collectAdeUsageStats({
      snapshot,
      args: {
        preset: "all",
        since: new Date(2026, 4, 29, 0, 0, 0, 0).toISOString(),
        until: new Date(2026, 4, 29, 23, 59, 59, 999).toISOString(),
      },
      nowMs: externalDay.getTime(),
    });

    expect(presetStats.providers.find((provider) => provider.provider === "codex")).toMatchObject({
      totalTokens: 150,
      adeOriginatedTokens: 100,
      externalTokens: 50,
    });
    expect(exactStats.providers.find((provider) => provider.provider === "codex")).toMatchObject({
      totalTokens: 50,
      adeOriginatedTokens: 0,
      externalTokens: 50,
    });

    const legacyCost = { ...cost, adeOriginatedDailyTokensByPreset: undefined };
    const legacyExactStats = collectAdeUsageStats({
      snapshot: { ...snapshot, costs: [legacyCost] },
      args: {
        preset: "all",
        since: new Date(2026, 4, 29, 0, 0, 0, 0).toISOString(),
        until: new Date(2026, 4, 29, 23, 59, 59, 999).toISOString(),
      },
      nowMs: externalDay.getTime(),
    });
    expect(legacyExactStats.providers.find((provider) => provider.provider === "codex")).not.toHaveProperty("adeOriginatedTokens");
    expect(legacyExactStats.providers.find((provider) => provider.provider === "codex")).not.toHaveProperty("externalTokens");
  });
  it("daily points carry output and cache split", () => {
    const now = new Date(2026, 4, 29, 12, 0, 0, 0);
    const date = localDayKey(now);
    const stats = collectAdeUsageStats({
      snapshot: {
        windows: [],
        pacing: calculatePacing([]),
        costs: [{
          provider: "codex",
          todayCostUsd: 0,
          last30dCostUsd: 0,
          tokenBreakdown: {},
          dailyTokenBreakdownByPreset: {
            today: {
              [date]: {
                "gpt-5.5": { input: 100, output: 40, cached: 25, cacheWrite: 5 },
              },
            },
          },
        }],
        adeCosts: [],
        extraUsage: [],
        lastPolledAt: now.toISOString(),
        errors: [],
      },
      args: { preset: "today" },
      nowMs: now.getTime(),
    } as any);

    expect(stats.daily.find((point) => point.date === date)).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 30,
      totalTokens: 170,
    });
  });

  it("legacy daily totals do not masquerade as input tokens", () => {
    const now = new Date(2026, 4, 29, 12, 0, 0, 0);
    const date = localDayKey(now);
    const stats = collectAdeUsageStats({
      snapshot: {
        windows: [],
        pacing: calculatePacing([]),
        costs: [{
          provider: "claude",
          todayCostUsd: 0,
          last30dCostUsd: 0,
          tokenBreakdown: {},
          dailyTokensByPreset: { today: { [date]: 55 } },
        }],
        adeCosts: [],
        extraUsage: [],
        lastPolledAt: now.toISOString(),
        errors: [],
      },
      args: { preset: "today" },
      nowMs: now.getTime(),
    } as any);

    expect(stats.daily.find((point) => point.date === date)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 55,
    });
  });

  it("day keys are local-timezone stable across DST calendar fixtures", () => {
    expect(localDayKey("2026-03-08")).toBe("2026-03-08");
    const fixtures = [
      {
        timezone: "America/Los_Angeles",
        start: new Date(2026, 2, 7, 12),
        until: new Date(2026, 2, 10, 12),
        expected: ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"],
      },
      {
        timezone: "Pacific/Auckland",
        start: new Date(2026, 3, 3, 12),
        until: new Date(2026, 3, 6, 12),
        expected: ["2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06"],
      },
    ];

    for (const fixture of fixtures) {
      const range = {
        preset: "7d" as const,
        since: new Date(
          fixture.start.getFullYear(),
          fixture.start.getMonth(),
          fixture.start.getDate(),
        ).toISOString(),
        until: fixture.until.toISOString(),
      };
      expect(makeDailySkeleton(range, fixture.until.getTime()).map((point) => point.date), fixture.timezone)
        .toEqual(fixture.expected);
      expect(dateIntersectsRange(fixture.expected[1]!, range), fixture.timezone).toBe(true);
    }
  });

  it("extends the skeleton instead of dropping an observed local day", () => {
    const now = new Date(2026, 4, 29, 12);
    const oldDate = "2024-01-02";
    const stats = collectAdeUsageStats({
      snapshot: {
        windows: [],
        pacing: calculatePacing([]),
        costs: [{
          provider: "claude",
          todayCostUsd: 0,
          last30dCostUsd: 0,
          tokenBreakdown: {},
          dailyTokenBreakdownByPreset: {
            all: { [oldDate]: { opus: { input: 1, output: 2, cached: 3 } } },
          },
        }],
        adeCosts: [],
        extraUsage: [],
        lastPolledAt: now.toISOString(),
        errors: [],
      },
      args: { preset: "all" },
      nowMs: now.getTime(),
    } as any);

    expect(stats.daily.find((point) => point.date === oldDate)?.totalTokens).toBe(6);
  });
});

describe("daily byProvider split", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function snapshotWithCosts(costs: unknown[], lastPolledAtMs: number) {
    return {
      windows: [],
      pacing: calculatePacing([]),
      costs,
      adeCosts: [],
      extraUsage: [],
      lastPolledAt: new Date(lastPolledAtMs).toISOString(),
      errors: [],
    } as any;
  }

  it("splits each day by provider and reconciles with the range cost", () => {
    const nowMs = Date.now();
    const todayMs = nowMs - 60_000;
    const twoDaysAgoMs = nowMs - 2 * DAY_MS;
    const claude = aggregateCosts([
      {
        messageId: "claude:today",
        model: "claude-3-5-sonnet",
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 0,
        timestamp: todayMs,
      },
      {
        messageId: "claude:older",
        model: "claude-3-5-sonnet",
        inputTokens: 200,
        outputTokens: 100,
        cachedTokens: 0,
        timestamp: twoDaysAgoMs,
      },
    ], "claude");
    const codex = aggregateCosts([
      {
        messageId: "codex:today",
        model: "gpt-5.5",
        inputTokens: 400,
        outputTokens: 200,
        cachedTokens: 0,
        timestamp: todayMs,
      },
    ], "codex");

    const stats = collectAdeUsageStats({
      snapshot: snapshotWithCosts([claude, codex], nowMs),
      args: { preset: "7d" },
      nowMs,
    });

    const todayKey = localDayKey(todayMs);
    const olderKey = localDayKey(twoDaysAgoMs);

    // Multi-provider day.
    const todayPoint = stats.daily.find((point) => point.date === todayKey);
    expect(Object.keys(todayPoint?.byProvider ?? {}).sort()).toEqual(["claude", "codex"]);
    expect(todayPoint?.byProvider?.claude?.totalTokens).toBe(1500);
    expect(todayPoint?.byProvider?.codex?.totalTokens).toBe(600);
    expect(todayPoint?.byProvider?.claude?.costUsd).toBeGreaterThan(0);
    expect(todayPoint?.byProvider?.codex?.costUsd).toBeGreaterThan(0);

    // Single-provider day.
    const olderPoint = stats.daily.find((point) => point.date === olderKey);
    expect(Object.keys(olderPoint?.byProvider ?? {})).toEqual(["claude"]);
    expect(olderPoint?.byProvider?.claude?.totalTokens).toBe(300);

    // Days with no provider attribution omit the map entirely.
    const emptyDays = stats.daily.filter((point) => point.date !== todayKey && point.date !== olderKey);
    expect(emptyDays.length).toBeGreaterThan(0);
    for (const point of emptyDays) {
      expect(point.byProvider).toBeUndefined();
    }

    // Provider keys line up with the summary rows, and the daily costs add up
    // to the range cost those rows report.
    expect(stats.providers.map((provider) => provider.provider).sort()).toEqual(["claude", "codex"]);
    for (const provider of stats.providers) {
      expect(provider.rangeCostUsd).toBeGreaterThan(0);
      const summed = stats.daily.reduce(
        (total, point) => total + (point.byProvider?.[provider.provider]?.costUsd ?? 0),
        0,
      );
      expect(summed).toBeCloseTo(provider.rangeCostUsd, 2);
    }
  });

  it("reconciles daily and range costs for an exact custom range", () => {
    const nowMs = Date.now();
    const todayMs = nowMs - 60_000;
    const threeDaysAgoMs = nowMs - 3 * DAY_MS;
    const cost = aggregateCosts([
      {
        messageId: "codex:in-range",
        model: "gpt-5.5",
        inputTokens: 800,
        outputTokens: 300,
        cachedTokens: 0,
        timestamp: todayMs,
      },
      {
        messageId: "codex:out-of-range",
        model: "gpt-5.5",
        inputTokens: 5000,
        outputTokens: 2000,
        cachedTokens: 0,
        timestamp: threeDaysAgoMs,
      },
    ], "codex");

    const dayStart = new Date(todayMs);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(todayMs);
    dayEnd.setHours(23, 59, 59, 999);

    const stats = collectAdeUsageStats({
      snapshot: snapshotWithCosts([cost], nowMs),
      args: { preset: "7d", since: dayStart.toISOString(), until: dayEnd.toISOString() },
      nowMs,
    });

    const todayKey = localDayKey(todayMs);
    const todayPoint = stats.daily.find((point) => point.date === todayKey);
    expect(todayPoint?.byProvider?.codex?.totalTokens).toBe(1100);
    // The out-of-range day is excluded from both the daily split and the summary.
    expect(stats.daily.find((point) => point.date === localDayKey(threeDaysAgoMs))?.byProvider).toBeUndefined();

    const summary = stats.providers.find((provider) => provider.provider === "codex");
    expect(summary?.totalTokens).toBe(1100);
    expect(summary?.rangeCostUsd).toBeGreaterThan(0);
    expect(todayPoint?.byProvider?.codex?.costUsd).toBeCloseTo(summary?.rangeCostUsd ?? 0, 2);
  });

  it("apportions legacy flat daily totals without re-pricing them", () => {
    const now = new Date(2026, 4, 29, 12, 0, 0, 0);
    const today = localDayKey(now);
    const yesterday = localDayKey(new Date(2026, 4, 28, 12, 0, 0, 0));
    const stats = collectAdeUsageStats({
      snapshot: snapshotWithCosts([{
        provider: "claude",
        todayCostUsd: 1,
        last30dCostUsd: 4,
        tokenBreakdown: { "claude-3-5-sonnet": { input: 30, output: 10, cached: 0 } },
        costUsdByPreset: { "7d": 4 },
        dailyTokensByPreset: { "7d": { [today]: 30, [yesterday]: 10 } },
      }], now.getTime()),
      args: { preset: "7d" },
      nowMs: now.getTime(),
    });

    expect(stats.daily.find((point) => point.date === today)?.byProvider?.claude)
      .toEqual({ totalTokens: 30, costUsd: 3 });
    expect(stats.daily.find((point) => point.date === yesterday)?.byProvider?.claude)
      .toEqual({ totalTokens: 10, costUsd: 1 });
    const summed = stats.daily.reduce(
      (total, point) => total + (point.byProvider?.claude?.costUsd ?? 0),
      0,
    );
    expect(summed).toBeCloseTo(
      stats.providers.find((provider) => provider.provider === "claude")?.rangeCostUsd ?? 0,
      2,
    );
  });

  /**
   * The split has to survive the whole way to the chart, not just exist in the
   * stats payload. A stale persisted snapshot used to reach the renderer with
   * no `byProvider` at all, and `buildDayColumns` — correctly — collapsed it to
   * one "All providers" band, which is what the user saw. This test pins the
   * two halves together so neither can drift alone.
   */
  it("reaches the renderer chart as a per-provider split, not a combined band", () => {
    const nowMs = Date.now();
    const todayMs = nowMs - 60_000;
    const claude = aggregateCosts([{
      messageId: "claude:today",
      model: "claude-3-5-sonnet",
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 0,
      timestamp: todayMs,
    }], "claude");
    const codex = aggregateCosts([{
      messageId: "codex:today",
      model: "gpt-5.5",
      inputTokens: 400,
      outputTokens: 200,
      cachedTokens: 0,
      timestamp: todayMs,
    }], "codex");

    const stats = collectAdeUsageStats({
      snapshot: snapshotWithCosts([claude, codex], nowMs),
      args: { preset: "7d" },
      nowMs,
    });

    const days = stats.daily.map((point) => point.date);
    for (const metric of ["tokens", "cost"] as const) {
      const columns = buildDayColumns(days, stats.daily, metric);
      expect(columns.combined).toBe(false);
      expect(columns.providers.sort()).toEqual(["claude", "codex"]);
      expect(columns.providers).not.toContain(USAGE_CHART_COMBINED_ID);
      const todayColumn = columns.columns.find((column) => column.date === localDayKey(todayMs));
      expect(Object.keys(todayColumn?.values ?? {}).sort()).toEqual(["claude", "codex"]);
      expect(todayColumn?.total).toBeGreaterThan(0);
    }
  });
});

// ── collectAdeUsageStats ─────────────────────────────────────────

describe("collectAdeUsageStats", () => {
  it("keeps GitHub and local activity separate", () => {
    const nowMs = Date.parse("2026-05-29T12:00:00.000Z");
    const snapshot = {
      windows: [],
      pacing: calculatePacing([]),
      pacingByProvider: {},
      costs: [
        {
          provider: "codex",
          todayCostUsd: 1.25,
          last30dCostUsd: 5.5,
          costUsdByPreset: {
            today: 1.25,
            "7d": 2.75,
            "30d": 5.5,
            all: 5.5,
          },
          tokenBreakdown: {
            "gpt-5-codex": { input: 100, output: 50, cached: 20 },
          },
          tokenBreakdownByPreset: {
            "7d": {
              "gpt-5-codex": { input: 100, output: 50, cached: 20 },
            },
          },
        },
      ],
      adeCosts: [],
      extraUsage: [],
      lastPolledAt: new Date(nowMs).toISOString(),
      errors: [],
    } as any;
    const githubStats = {
      repo: "arul28/ADE",
      available: true,
      fetchedAt: new Date(nowMs).toISOString(),
      error: null,
      commitsCreated: 9,
      prsTracked: 7,
      prsOpen: 3,
      prsMerged: 6,
      prsClosed: 1,
      prAdditions: 9_106,
      prDeletions: 1_313,
      filesChanged: 86,
      daily: [
        {
          date: "2026-05-29",
          commits: 9,
          prs: 7,
          insertions: 9_106,
          deletions: 1_313,
          filesChanged: 86,
        },
      ],
    };

    const stats = collectAdeUsageStats({
      snapshot,
      githubStats,
      databaseStats: {
        summary: {
          commitsCreated: 2,
          pushOperations: 3,
          prLandings: 1,
          filesChanged: 4,
          insertions: 120,
          deletions: 20,
        },
        providers: [],
        models: [],
        agentProviders: [],
        agentModels: [],
        features: [],
        lanes: [],
        activities: [],
        clients: [],
        daily: [{
          date: "2026-05-29",
          commits: 2,
          prs: 1,
          insertions: 120,
          deletions: 20,
          filesChanged: 4,
        }],
      } as any,
      args: { preset: "7d" },
      nowMs,
    });

    expect(stats.summary.tokenTotalSource).toBe("provider_logs");
    expect(stats.summary.totalTokens).toBe(170);
    expect(stats.summary.observedProviderCostRangeUsd).toBe(2.75);
    expect(stats.summary.adeRuntimeTokens).toBe(0);
    expect(stats.summary.adeTotalTokens).toBe(0);
    expect(stats.summary.trackedAdeTokens).toBe(0);
    expect(stats.summary.workerTokens).toBe(0);
    expect(stats.summary.activeLanes).toBe(0);
    expect(stats.summary.prsTracked).toBe(7);
    expect(stats.summary.prsOpen).toBe(3);
    expect(stats.summary.prsMerged).toBe(6);
    expect(stats.summary.prsClosed).toBe(1);
    expect(stats.summary.commitsCreated).toBe(2);
    expect(stats.summary.prAdditions).toBe(9_106);
    expect(stats.summary.prDeletions).toBe(1_313);
    expect(stats.github.repo).toBe("arul28/ADE");
    expect(stats.githubActivity).toMatchObject({ commits: 9, prsTracked: 7, prAdditions: 9_106 });
    expect(stats.localActivity).toMatchObject({ commits: 2, prLandings: 1, insertions: 120 });
    expect(stats.providers.map((provider) => provider.provider)).toEqual(["codex"]);
    expect(stats.adeProviders).toEqual([]);
    expect(stats.agentProviders).toEqual([]);
    expect(stats.daily.find((point) => point.date === "2026-05-29")).toMatchObject({
      commits: 2,
      prs: 1,
      insertions: 120,
      deletions: 20,
      filesChanged: 4,
      githubCommits: 9,
      githubPrs: 7,
      githubAdditions: 9_106,
      githubDeletions: 1_313,
    });
  });
});

describe("GitHub activity scan", () => {
  it("stops pull request pagination once a page's oldest update crosses the range start", async () => {
    const runCommand = vi.fn(async (_command: string, _args: string[]) => JSON.stringify({
      nodes: [
        { number: 3, createdAt: "2026-05-29T12:00:00.000Z", updatedAt: "2026-05-29T12:00:00.000Z", author: { login: "arul" } },
        { number: 2, createdAt: "2026-05-28T12:00:00.000Z", updatedAt: "2026-05-20T12:00:00.000Z", author: { login: "arul" } },
      ],
      pageInfo: { hasNextPage: true, endCursor: "next-page" },
    }));

    const rows = await scanGithubPullRequestPages({
      projectRoot: "/repo",
      repoParts: { owner: "arul", name: "ADE" },
      viewer: "arul",
      range: {
        preset: "7d",
        since: "2026-05-23T00:00:00.000Z",
        until: "2026-05-29T23:59:59.000Z",
      },
      runCommand,
    });

    expect(rows.map((row) => row.number)).toEqual([3, 2]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      expect.stringContaining("field: UPDATED_AT"),
    ]));
  });

  it("continues past old creations to count a long-lived PR merged in range", async () => {
    const pages = [
      {
        nodes: [
          {
            number: 2,
            createdAt: "2026-01-10T12:00:00.000Z",
            updatedAt: "2026-05-29T12:00:00.000Z",
            author: { login: "arul" },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "next-page" },
      },
      {
        nodes: [
          {
            number: 1,
            state: "MERGED",
            createdAt: "2025-12-01T12:00:00.000Z",
            updatedAt: "2026-05-28T12:00:00.000Z",
            mergedAt: "2026-05-28T12:00:00.000Z",
            author: { login: "arul" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    const runCommand = vi.fn(async () => JSON.stringify(pages.shift()));

    const rows = await scanGithubPullRequestPages({
      projectRoot: "/repo",
      repoParts: { owner: "arul", name: "ADE" },
      viewer: "arul",
      range: {
        preset: "7d",
        since: "2026-05-23T00:00:00.000Z",
        until: "2026-05-29T23:59:59.000Z",
      },
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(rows).toContainEqual(expect.objectContaining({
      number: 1,
      createdAt: "2025-12-01T12:00:00.000Z",
      mergedAt: "2026-05-28T12:00:00.000Z",
    }));
  });
});

// ── resolveTokenPrice ────────────────────────────────────────────

describe("resolveTokenPrice", () => {
  function missingPricedRefsForDescriptors(descriptors: ModelDescriptor[]): string[] {
    const missing: string[] = [];
    for (const descriptor of descriptors) {
      const refs = [
        descriptor.id,
        descriptor.providerModelId,
        descriptor.shortId,
        ...(descriptor.aliases ?? []),
      ];
      for (const ref of refs) {
        const price = resolveTokenPrice(ref);
        if (price.input <= 0 || price.output <= 0) {
          missing.push(`${descriptor.id} -> ${ref}`);
        }
      }
    }
    return missing;
  }

  it("returns opus pricing for opus models", () => {
    const price = resolveTokenPrice("claude-opus-4");
    expect(price.input).toBe(15 / 1_000_000);
    expect(price.output).toBe(75 / 1_000_000);
  });

  it("uses Opus 5 pricing for the static fallback", () => {
    const price = resolveTokenPrice("claude-opus-5");
    expect(price.input).toBe(5 / 1_000_000);
    expect(price.output).toBe(25 / 1_000_000);
    expect(price.cacheRead).toBe(0.5 / 1_000_000);
    expect(price.cacheWrite).toBe(6.25 / 1_000_000);
  });

  it("returns sonnet pricing for sonnet models", () => {
    const price = resolveTokenPrice("claude-3-5-sonnet");
    expect(price.input).toBe(3 / 1_000_000);
  });

  it("uses Sonnet 5 introductory pricing for the static fallback", () => {
    const price = resolveTokenPrice("claude-sonnet-5");
    expect(price.input).toBe(2 / 1_000_000);
    expect(price.output).toBe(10 / 1_000_000);
    expect(price.cacheRead).toBe(0.2 / 1_000_000);
    expect(price.cacheWrite).toBe(2.5 / 1_000_000);
  });

  it("returns haiku pricing for haiku models", () => {
    const price = resolveTokenPrice("claude-haiku-3");
    expect(price.input).toBe(1 / 1_000_000);
  });

  it("returns codex pricing for GPT/codex models", () => {
    const price = resolveTokenPrice("gpt-4o");
    expect(price.input).toBe(2.5 / 1_000_000);
    expect(price.cacheRead).toBe(1.25 / 1_000_000);
  });

  it("returns mini pricing for mini OpenAI models", () => {
    const price = resolveTokenPrice("gpt-5.4-mini");
    expect(price.input).toBe(0.75 / 1_000_000);
    expect(price.output).toBe(4.5 / 1_000_000);
  });

  it("does not treat Gemini as a mini OpenAI model", () => {
    const price = resolveTokenPrice("gemini-2.5-pro");
    expect(price.input).toBe(1.25 / 1_000_000);
    expect(price.output).toBe(10 / 1_000_000);
  });

  it("returns zero pricing for unknown models", () => {
    const price = resolveTokenPrice("unknown-model");
    expect(price.input).toBe(0);
    expect(price.output).toBe(0);
  });

  /**
   * Settled policy: the maintained public rate list wins whenever it prices a
   * model, and ADE's static table is the fallback for when it cannot be
   * fetched. Two machines — one with the cached list, one without — reporting
   * different costs for identical usage is what this ordering prevents.
   */
  it("prefers the public rate list over the built-in table, and falls back cleanly", () => {
    setDynamicTokenPricingForTest({
      "claude-sonnet-5": {
        input: 7 / 1_000_000,
        output: 70 / 1_000_000,
        cacheWrite: 8.75 / 1_000_000,
        cacheRead: 0.7 / 1_000_000,
      },
    });
    // The list's number, not the table's 2/10.
    expect(resolveTokenPrice("claude-sonnet-5").input).toBe(7 / 1_000_000);
    expect(tokenPriceSource("claude-sonnet-5")).toBe("list");
    // A model the list has never heard of still prices from the table rather
    // than falling to zero.
    expect(resolveTokenPrice("claude-opus-5").input).toBe(5 / 1_000_000);
    expect(tokenPriceSource("claude-opus-5")).toBe("fallback");

    // No list at all — a failed fetch — leaves every rate intact.
    resetDynamicTokenPricingForTest({ disableDiskCache: true });
    expect(resolveTokenPrice("claude-sonnet-5").input).toBe(2 / 1_000_000);
    expect(resolveTokenPrice("claude-opus-5").input).toBe(5 / 1_000_000);
    expect(tokenPriceSource("claude-sonnet-5")).toBe("fallback");
  });

  /**
   * Most list rows carry input and output and nothing else. Dropping such a row
   * back to the whole static entry would hand the list's authority to a model
   * the list actually prices; the missing field is filled on its own.
   */
  it("fills a partial rate-list entry field by field, not by falling back to the whole static row", () => {
    resetDynamicTokenPricingForTest({ disableDiskCache: true });
    const parsed = _pricingTesting.parsePricingMap({
      // Input and output only, exactly as the OpenAI rows arrive.
      "gpt-5.6-luna": { input_cost_per_token: 9 / 1_000_000, output_cost_per_token: 90 / 1_000_000 },
    });
    const price = parsed?.get("gpt-5.6-luna");
    // The list's own input/output survive...
    expect(price?.input).toBe(9 / 1_000_000);
    expect(price?.output).toBe(90 / 1_000_000);
    // ...and only the absent cache fields come from the table's entry for that
    // same model, rather than the table's input/output overriding the list.
    expect(price?.cacheRead).toBe(0.02 / 1_000_000);
  });

  // Reconciled against the list on 2026-08-10. These four moved, so a user's
  // cost figures moved with them; the values are pinned so a silent drift back
  // to the old table is a failing test rather than a quiet re-divergence.
  it("carries the reconciled rates for the models where the table disagreed with the list", () => {
    resetDynamicTokenPricingForTest({ disableDiskCache: true });
    expect(resolveTokenPrice("gpt-5.6-luna").input).toBe(0.2 / 1_000_000);
    expect(resolveTokenPrice("gpt-5.6-luna").output).toBe(1.2 / 1_000_000);
    expect(resolveTokenPrice("gpt-5.6-terra").input).toBe(2 / 1_000_000);
    expect(resolveTokenPrice("gpt-5.6-terra").output).toBe(12 / 1_000_000);
    expect(resolveTokenPrice("gpt-4o-mini").input).toBe(0.165 / 1_000_000);
    expect(resolveTokenPrice("claude-3-5-haiku").input).toBe(1 / 1_000_000);
    // Sonnet 4.6 was aliased onto Sonnet 5 and billed at 2/10; the list prices
    // it at 3/15, and every spelling of the name must agree.
    for (const name of ["claude-sonnet-4.6", "claude-4.6-sonnet", "claude-4.6-sonnet-thinking", "anthropic--claude-4.6-sonnet"]) {
      expect(resolveTokenPrice(name).input).toBe(3 / 1_000_000);
      expect(resolveTokenPrice(name).output).toBe(15 / 1_000_000);
    }
  });

  it("prefers Codeburn-style dynamic pricing with provider and date normalization", () => {
    setDynamicTokenPricingForTest({
      "openai/gpt-dynamic": {
        input: 9 / 1_000_000,
        output: 27 / 1_000_000,
        cacheWrite: 11.25 / 1_000_000,
        cacheRead: 0.9 / 1_000_000,
      },
    });

    const price = resolveTokenPrice("openai/gpt-dynamic-20260101");
    expect(price.input).toBe(9 / 1_000_000);
    expect(price.output).toBe(27 / 1_000_000);
  });

  it("uses Codeburn-compatible aliases for runtime auto models", () => {
    const price = resolveTokenPrice("cursor-auto");
    expect(price.input).toBe(3 / 1_000_000);
    expect(price.output).toBe(15 / 1_000_000);
    expect(resolveTokenPrice("composer-2.5").input).toBe(2 / 1_000_000);
  });

  it("prices every ADE Claude and Codex registry id and alias without dynamic pricing", () => {
    const required = MODEL_REGISTRY.filter(
      (descriptor) => descriptor.isCliWrapped && (descriptor.family === "anthropic" || descriptor.family === "openai"),
    );

    expect(missingPricedRefsForDescriptors(required)).toEqual([]);
  });

  it("prices known Cursor model families and variants without dynamic pricing", () => {
    const cursorModelIds = [
      "auto",
      "cursor-auto",
      "cursor-agent-auto",
      "composer-1",
      "composer-1.5",
      "composer-2",
      "composer-2.5",
      "composer-2.5-fast",
      "composer-latest",
      "claude-4-sonnet",
      "claude-4-sonnet-1m",
      "claude-4-sonnet-thinking",
      "claude-4.5-sonnet",
      "claude-4.5-sonnet-thinking",
      "claude-4.6-sonnet",
      "claude-4.6-sonnet-medium",
      "claude-4.6-sonnet-high",
      "claude-4.6-sonnet-low",
      "claude-4.6-sonnet-thinking",
      "claude-4.6-sonnet-high-thinking",
      "claude-4-opus",
      "claude-4.5-opus",
      "claude-4.5-opus-high",
      "claude-4.5-opus-low",
      "claude-4.5-opus-medium",
      "claude-4.5-opus-high-thinking",
      "claude-4.6-opus",
      "claude-4.6-opus-fast-mode",
      "claude-4.6-opus-high",
      "claude-4.6-opus-low",
      "claude-4.6-opus-medium",
      "claude-4.6-opus-high-thinking",
      "claude-4.7-opus",
      "claude-opus-4-7-thinking-high",
      "claude-4.5-haiku",
      "claude-4.6-haiku",
      "gpt-5-fast",
      "gpt-5.2-low",
      "gpt-5.1-codex-high",
      "gpt-5",
      "gpt-5.1",
      "gpt-5.2",
      "gpt-5.3",
      "gpt-5.3-codex",
      "gpt-5.3-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o4-mini",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3-flash-agent",
      "gemini-3-pro",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite",
      "grok-code-fast-1",
      "kimi-k2.5",
      "kimi-k2-thinking",
    ];
    const descriptors = cursorModelIds.map((modelId) => createDynamicCursorCliModelDescriptor(modelId));

    expect(missingPricedRefsForDescriptors(descriptors)).toEqual([]);
  });
});

// ── isCodexTokenStale ────────────────────────────────────────────

describe("isCodexTokenStale", () => {
  it("returns false when no lastRefresh", () => {
    expect(isCodexTokenStale({ accessToken: "tok" })).toBe(false);
  });

  it("returns false when token is fresh", () => {
    expect(
      isCodexTokenStale({ accessToken: "tok", lastRefresh: Date.now() - 1000 })
    ).toBe(false);
  });

  it("returns true when token is older than 8 days", () => {
    const nineDaysAgo = Date.now() - 9 * 24 * 60 * 60 * 1000;
    expect(
      isCodexTokenStale({ accessToken: "tok", lastRefresh: nineDaysAgo })
    ).toBe(true);
  });
});

// ── isTokenExpiredOrExpiring ──────────────────────────────────────

describe("isTokenExpiredOrExpiring", () => {
  it("returns false when no expiresAt", () => {
    expect(isTokenExpiredOrExpiring({ accessToken: "tok" })).toBe(false);
  });

  it("returns false when token is fresh", () => {
    expect(isTokenExpiredOrExpiring({ accessToken: "tok", expiresAt: Date.now() + 3_600_000 })).toBe(false);
  });

  it("returns true when token is expired", () => {
    expect(isTokenExpiredOrExpiring({ accessToken: "tok", expiresAt: Date.now() - 1000 })).toBe(true);
  });

  it("returns true when token expires within 5 minutes", () => {
    expect(isTokenExpiredOrExpiring({ accessToken: "tok", expiresAt: Date.now() + 2 * 60_000 })).toBe(true);
  });
});

describe("parseClaudeWindows", () => {
  it("accepts the oauth snake_case response shape", () => {
    const result = parseClaudeWindows({
      five_hour: { utilization: 35, resets_at: "2026-03-14T02:00:01.263755+00:00" },
      seven_day: { utilization: 17, resets_at: "2026-03-20T03:00:00.263780+00:00" },
      seven_day_sonnet: { utilization: 0, resets_at: "2026-03-20T21:00:00.263794+00:00" },
    });

    expect(result.windows).toHaveLength(2);
    expect(result.windows.find((window) => window.windowType === "five_hour")?.percentUsed).toBe(35);
    expect(result.windows.find((window) => window.windowType === "weekly")?.percentUsed).toBe(17);
    expect(result.windows.find((window) => window.windowType === "weekly")?.modelBreakdown?.sonnet).toBe(0);
  });

  it("also accepts camelCase response keys", () => {
    const result = parseClaudeWindows({
      fiveHour: { used_percent: 22, resetsAt: "2026-03-14T02:00:01.263755+00:00" },
      sevenDay: { percent_used: 41, resetsAt: "2026-03-20T03:00:00.263780+00:00" },
      sevenDayOpus: { used_percent: 5, resetsAt: "2026-03-20T21:00:00.263794+00:00" },
    });

    expect(result.windows).toHaveLength(2);
    expect(result.windows.find((window) => window.windowType === "five_hour")?.percentUsed).toBe(22);
    expect(result.windows.find((window) => window.windowType === "weekly")?.modelBreakdown?.opus).toBe(5);
  });

  it("uses a zero reset countdown for malformed provider timestamps", () => {
    const result = parseClaudeWindows({
      five_hour: { utilization: 35, resets_at: "not-a-date" },
    });

    expect(result.windows).toEqual([
      expect.objectContaining({
        resetsAt: "not-a-date",
        resetsInMs: 0,
      }),
    ]);
  });

  it("parses extra_usage when present", () => {
    const result = parseClaudeWindows({
      five_hour: { utilization: 15, resets_at: "2026-03-14T21:00:00+00:00" },
      seven_day: { utilization: 22, resets_at: "2026-03-20T03:00:00+00:00" },
      extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 1500, currency: "usd" },
    });

    expect(result.extraUsage).toBeDefined();
    expect(result.extraUsage!.isEnabled).toBe(true);
    expect(result.extraUsage!.usedCreditsUsd).toBe(15); // 1500 cents / 100
    expect(result.extraUsage!.monthlyLimitUsd).toBe(100); // 10000 cents / 100
    expect(result.extraUsage!.currency).toBe("usd");
  });

  it("handles extra_usage with zero limit", () => {
    const result = parseClaudeWindows({
      five_hour: { utilization: 15, resets_at: "2026-03-14T21:00:00+00:00" },
      seven_day: { utilization: 22, resets_at: "2026-03-20T03:00:00+00:00" },
      extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 0, utilization: null },
    });

    expect(result.extraUsage).toBeDefined();
    expect(result.extraUsage!.usedCreditsUsd).toBe(0);
    expect(result.extraUsage!.monthlyLimitUsd).toBe(0);
  });
});

describe("parseClaudeCliUsage", () => {
  it("parses Claude's interactive usage panel as a bounded fallback", () => {
    const windows = parseClaudeCliUsage(`
Settings: Usage
Current session
75% left
Resets 5pm
Current week (all models)
40% used
Resets Jul 12 at 3pm
`);

    expect(windows).toHaveLength(2);
    expect(windows.find((window) => window.windowType === "five_hour")?.percentUsed).toBe(25);
    expect(windows.find((window) => window.windowType === "weekly")?.percentUsed).toBe(40);
    expect(windows.every((window) => Number.isFinite(Date.parse(window.resetsAt)))).toBe(true);
  });
});

// readClaudeCredentials contract tests live in
// ../ai/providerCredentialSources.test.ts, colocated with the module.

describe("parseCodexRateLimitWindows", () => {
  it("classifies current weekly-only wham responses by their duration", () => {
    const result = parseCodexRateLimitWindows({
      rate_limit: {
        primary_window: {
          used_percent: 63,
          reset_at: 1773853354,
          limit_window_seconds: 7 * 24 * 60 * 60,
        },
        secondary_window: null,
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        provider: "codex",
        windowType: "weekly",
        percentUsed: 63,
        windowDurationMs: 7 * 24 * 60 * 60_000,
      }),
    ]);
  });

  it("detects five-hour and weekly wham windows without relying on their positions", () => {
    const result = parseCodexRateLimitWindows({
      rate_limit: {
        primary_window: {
          used_percent: 63,
          reset_at: 1773853354,
          limit_window_seconds: 7 * 24 * 60 * 60,
        },
        secondary_window: {
          used_percent: 15,
          reset_at: 1773446952,
          limit_window_seconds: 5 * 60 * 60,
        },
      },
    });

    expect(result).toHaveLength(2);
    expect(result.find((window) => window.windowType === "five_hour")?.percentUsed).toBe(15);
    expect(result.find((window) => window.windowType === "weekly")?.percentUsed).toBe(63);
  });

  it("accepts the CodexBar CLI rateLimits shape", () => {
    const result = parseCodexRateLimitWindows({
      rateLimits: {
        primary: { usedPercent: 17, resetsAt: 1773446952 },
        secondary: { usedPercent: 64, resetsAt: 1773853354 },
      },
    });

    expect(result).toHaveLength(2);
    expect(result.find((window) => window.windowType === "five_hour")?.percentUsed).toBe(17);
    expect(result.find((window) => window.windowType === "weekly")?.percentUsed).toBe(64);
  });

  it.each([
    ["camel-case true", { rateLimits: { spendControlReached: true } }, true],
    ["snake-case false", { rateLimits: { spend_control_reached: false } }, false],
    ["null", { rateLimits: { spendControlReached: null } }, undefined],
    ["absent", { rateLimits: {} }, undefined],
  ])("parses provider-level spend control when %s", (_name, payload, expected) => {
    expect(parseCodexRateLimitSnapshot(payload).spendControlReached).toBe(expected);
  });

  it("preserves native Codex bucket durations", () => {
    const result = parseCodexRateLimitWindows({
      rateLimitsByLimitId: {
        primary_tokens: {
          primary: {
            usedPercent: 12,
            resetsAt: 1773446952,
            windowDurationMins: 60,
          },
        },
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: "codex",
      windowType: "five_hour",
      percentUsed: 12,
      windowDurationMs: 60 * 60_000,
    });
  });
});

describe("pollCodexViaCliRpc", () => {
  const originalPlatform = process.platform;
  const originalComSpec = process.env.ComSpec;

  beforeEach(() => {
    setPlatform("win32");
    process.env.ComSpec = "cmd.exe";
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalComSpec === undefined) {
      delete process.env.ComSpec;
    } else {
      process.env.ComSpec = originalComSpec;
    }
  });

  it("wraps extensionless Windows codex paths with cmd.exe and writes the combined JSONL payload once", async () => {
    const fake = createFakeCodexChild({
      stdout: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          rateLimits: {
            spendControlReached: false,
            primary: { usedPercent: 17, resetsAt: 1773446952 },
            secondary: { usedPercent: 64, resetsAt: 1773853354 },
          },
        },
      })}\n`,
    });

    mockState.resolveCodexExecutable.mockReturnValue({
      path: "C:\\Users\\me\\AppData\\Local\\Programs\\codex",
      source: "path",
    });
    mockState.spawn.mockReturnValue(fake.child);

    const logger = createLogger();
    const result = await pollCodexViaCliRpc(logger as any);

    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.spawn).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", '""C:\\Users\\me\\AppData\\Local\\Programs\\codex" "-s" "read-only" "-a" "untrusted" "app-server""'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
    expect(fake.stdinEmitter.write).toHaveBeenCalledTimes(1);
    expect(fake.written[0]).toMatch(/\n$/);
    expect(fake.written[0]).not.toMatch(/\n\n$/);
    expect(result.errors).toEqual([]);
    expect(result.windows).toHaveLength(2);
    expect(result.spendControlReached).toBe(false);
    expect(result.windows.find((window) => window.windowType === "five_hour")?.percentUsed).toBe(17);
  });

  it("spawns codex directly on POSIX without Windows shell options", async () => {
    setPlatform("linux");
    const fake = createFakeCodexChild({
      stdout: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          rateLimits: {
            primary: { usedPercent: 17, resetsAt: 1773446952 },
            secondary: { usedPercent: 64, resetsAt: 1773853354 },
          },
        },
      })}\n`,
    });

    mockState.resolveCodexExecutable.mockReturnValue({
      path: "codex",
      source: "path",
    });
    mockState.spawn.mockReturnValue(fake.child);

    const logger = createLogger();
    const result = await pollCodexViaCliRpc(logger as any);

    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    const [spawnFile, spawnArgs, spawnOptions] = mockState.spawn.mock.calls[0]!;
    expect(spawnFile).toBe("codex");
    expect(spawnArgs).toEqual(["-s", "read-only", "-a", "untrusted", "app-server"]);
    expect(spawnOptions).toEqual(expect.objectContaining({ windowsVerbatimArguments: false }));
    expect(fake.stdinEmitter.write).toHaveBeenCalledTimes(1);
    expect(fake.written[0]).toMatch(/\n$/);
    expect(fake.written[0]).not.toMatch(/\n\n$/);
    expect(result.errors).toEqual([]);
    expect(result.windows).toHaveLength(2);
    expect(result.windows.find((window) => window.windowType === "five_hour")?.percentUsed).toBe(17);
  });

  it("routes stdin EPIPE errors through cleanup and reports a CLI RPC failure", async () => {
    const stdinError = new Error("EPIPE");
    const fake = createFakeCodexChild({ stdinError });

    mockState.resolveCodexExecutable.mockReturnValue({
      path: "codex.exe",
      source: "path",
    });
    mockState.spawn.mockReturnValue(fake.child);

    const logger = createLogger();
    const result = await pollCodexViaCliRpc(logger as any);

    expect(result.windows).toEqual([]);
    expect(result.errors[0]).toContain("codex: CLI RPC error:");
    expect(logger.warn).toHaveBeenCalledWith(
      "usage.poll.codex_cli_rpc_stdin_failed",
      expect.objectContaining({ error: "EPIPE" }),
    );
  });

  it("logs non-zero exits after parsing close output", async () => {
    const fake = createFakeCodexChild({
      closeCode: 1,
      stderr: "codex said no\n",
    });

    mockState.resolveCodexExecutable.mockReturnValue({
      path: "codex.exe",
      source: "path",
    });
    mockState.spawn.mockReturnValue(fake.child);

    const logger = createLogger();
    const result = await pollCodexViaCliRpc(logger as any);

    expect(result.errors).toContain("codex: CLI RPC exited with non-zero code");
    expect(logger.warn).toHaveBeenCalledWith(
      "usage.poll.codex_cli_rpc_non_zero_exit",
      expect.objectContaining({ exitCode: 1, stderr: "codex said no\n" }),
    );
  });

  it("preserves Codex HTTP auth failures when CLI fallback cannot return windows", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "expired-token" },
    }));
    process.env.CODEX_HOME = tmpDir;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    const fake = createFakeCodexChild({
      closeCode: 1,
      stderr: "rpc unavailable\n",
    });
    mockState.resolveCodexExecutable.mockReturnValue({
      path: "codex.exe",
      source: "path",
    });
    mockState.spawn.mockReturnValue(fake.child);

    try {
      const logger = createLogger();
      const result = await pollCodexUsage(logger as any);

      expect(result.windows).toEqual([]);
      expect(result.errors).toContain("codex: API returned 401");
      expect(result.errors).toContain("codex: CLI RPC exited with non-zero code");
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      vi.unstubAllGlobals();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([403, 409, 429] as const)("does not spawn the CLI fallback for Codex HTTP %s", async (status) => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "rate-limited-token" },
    }));
    process.env.CODEX_HOME = tmpDir;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: async () => ({}),
    }));

    try {
      const logger = createLogger();
      const result = await pollCodexUsage(logger as any);

      expect(result.windows).toEqual([]);
      expect(result.errors).toEqual([`codex: API returned ${status}`]);
      expect(result.errorKind).toBe(status === 403 ? "forbidden" : status === 409 ? "conflict" : "rate_limited");
      expect(mockState.spawn).not.toHaveBeenCalled();
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      vi.unstubAllGlobals();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to Codex RPC after retryable HTTP server errors", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "ok-token" },
    }));
    process.env.CODEX_HOME = tmpDir;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    const fake = createFakeCodexChild({
      stdout: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          rateLimits: {
            primary: { usedPercent: 17, resetsAt: 1773446952 },
            secondary: { usedPercent: 64, resetsAt: 1773853354 },
          },
        },
      })}\n`,
    });
    mockState.resolveCodexExecutable.mockReturnValue({ path: "codex", source: "path" });
    mockState.spawn.mockReturnValue(fake.child);

    try {
      const result = await pollCodexUsage(createLogger() as any);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.windows).toHaveLength(2);
      expect(result.source).toBe("cli");
      expect(result.errors).toEqual([]);
      expect(mockState.spawn).toHaveBeenCalledTimes(1);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      vi.unstubAllGlobals();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to the Codex RPC when a successful HTTP response drifts", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "ok-token" },
    }));
    process.env.CODEX_HOME = tmpDir;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ renamed_rate_limit: {} }),
    }));
    const fake = createFakeCodexChild({
      stdout: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          rateLimits: {
            primary: { usedPercent: 17, resetsAt: 1773446952 },
            secondary: { usedPercent: 64, resetsAt: 1773853354 },
          },
        },
      })}\n`,
    });
    mockState.resolveCodexExecutable.mockReturnValue({ path: "codex", source: "path" });
    mockState.spawn.mockReturnValue(fake.child);

    try {
      const result = await pollCodexUsage(createLogger() as any);

      expect(result.windows).toHaveLength(2);
      expect(result.source).toBe("cli");
      expect(mockState.spawn).toHaveBeenCalledTimes(1);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      vi.unstubAllGlobals();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not launch app-server when HTTP returns complete rate-limit windows", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "ok-token" },
    }));
    process.env.CODEX_HOME = tmpDir;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        rate_limit: {
          spend_control_reached: true,
          primary_window: { used_percent: 15, reset_at: 1773446952 },
          secondary_window: { used_percent: 63, reset_at: 1773853354 },
        },
      }),
    }));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const fake = createFakeCodexChild({
      stdout: [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            dailyUsageBuckets: [
              { startDate: today.toISOString(), tokens: 123 },
            ],
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            messages: [
              {
                messageId: "msg-1",
                messageType: "headline",
                messageBody: "Native usage ready",
                createdAt: 1773446952,
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    });
    mockState.resolveCodexExecutable.mockReturnValue({
      path: "codex.exe",
      source: "path",
    });
    mockState.spawn.mockReturnValue(fake.child);

    try {
      const logger = createLogger();
      const result = await pollCodexUsage(logger as any);

      expect(result.errors).toEqual([]);
      expect(result.windows).toHaveLength(2);
      expect(result.source).toBe("http");
      expect(result.spendControlReached).toBe(true);
      expect(result.dailyUsage7d).toBeUndefined();
      expect(result.providerMessages).toBeUndefined();
      expect(mockState.spawn).not.toHaveBeenCalled();
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      vi.unstubAllGlobals();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Service Integration ──────────────────────────────────────────

describe("createUsageTrackingService", () => {
  const createFastDependencies = () => ({
    pollClaudeUsage: vi.fn(async () => ({ windows: [] as never[], extraUsage: null, errors: [] as never[] })),
    pollCodexUsage: vi.fn(async () => ({ windows: [] as never[], errors: [] as never[] })),
    scanClaudeLogs: vi.fn(async () => [] as never[]),
    scanCodexLogs: vi.fn(async () => [] as never[]),
    scanCursorLogs: vi.fn(async () => [] as never[]),
    scanCursorAgentLogs: vi.fn(async () => [] as never[]),
    scanOpenClawLogs: vi.fn(async () => [] as never[]),
    scanOpenCodeLogs: vi.fn(async () => [] as never[]),
    scanDroidLogs: vi.fn(async () => [] as never[]),
    scanCopilotLogs: vi.fn(async () => [] as never[]),
    scanGeminiLogs: vi.fn(async () => [] as never[]),
  });

  it("returns an empty snapshot before polling", () => {
    const logger = createLogger();
    const service = createUsageTrackingService({ logger });

    const snapshot = service.getUsageSnapshot();
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.pacing.status).toBe("on-track");
    expect(snapshot.costs).toEqual([]);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.lastPolledAt).toBeTruthy();

    service.dispose();
  });

  it("surfaces Codex spend control and accepts it after a cache JSON round-trip", async () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        ...dependencies,
        pollCodexUsage: vi.fn(async () => ({
          windows: [{
            provider: "codex" as const,
            windowType: "five_hour" as const,
            percentUsed: 100,
            resetsAt: new Date(Date.now() + 60_000).toISOString(),
            resetsInMs: 60_000,
          }],
          spendControlReached: true,
          errors: [],
        })),
      },
    });

    const snapshot = await service.poll({ reason: "user" });
    expect(snapshot.spendControlReached).toBe(true);

    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(isUsageSnapshot(roundTripped)).toBe(true);
    expect(roundTripped.spendControlReached).toBe(true);
    service.dispose();
  });

  it("records the attempt when a user retry is skipped by a rate-limit backoff", async () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const pollClaudeUsage = vi.fn(async () => ({
      windows: [] as never[],
      extraUsage: null,
      errors: ["claude: 429 Too Many Requests"],
      errorKind: "rate_limited" as const,
      retryAfterMs: 8 * 60_000,
    }));
    const service = createUsageTrackingService({
      logger,
      dependencies: { ...dependencies, pollClaudeUsage },
    });

    const first = await service.poll({ reason: "user" });
    const firstStatus = first.providerStatus?.claude;
    expect(firstStatus?.errorKind).toBe("rate_limited");
    expect(firstStatus?.nextRetryAt).toBeTruthy();
    expect(pollClaudeUsage).toHaveBeenCalledTimes(1);

    // The provider asked us to wait, so the retry is still not sent — but the
    // snapshot must move, or the Retry button is a silent no-op.
    // Comfortably outside timer granularity and `Date.now()` resolution: at 2ms
    // the strict comparison below sat inside the scheduler's own jitter and
    // could see two identical timestamps on a loaded CI box.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await service.poll({ reason: "user" });
    const secondStatus = second.providerStatus?.claude;
    expect(pollClaudeUsage).toHaveBeenCalledTimes(1);
    expect(secondStatus?.errorKind).toBe("rate_limited");
    expect(secondStatus?.nextRetryAt).toBeTruthy();
    expect(Date.parse(secondStatus?.lastAttemptAt ?? "")).toBeGreaterThan(
      Date.parse(firstStatus?.lastAttemptAt ?? ""),
    );

    service.dispose();
  });

  it("clamps out-of-range poll intervals internally", () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const service1 = createUsageTrackingService({ logger, pollIntervalMs: 100, dependencies });
    service1.start();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MIN_POLL_INTERVAL_MS);
    service1.dispose();

    const service2 = createUsageTrackingService({ logger, pollIntervalMs: 60 * 60 * 1000, dependencies });
    service2.start();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_POLL_INTERVAL_MS);
    service2.dispose();

    setTimeoutSpy.mockRestore();
  });

  it("does not reschedule after stop while the startup poll is in flight", async () => {
    const logger = createLogger();
    let resolveClaude!: (result: { windows: never[]; extraUsage: null; errors: never[] }) => void;
    const dependencies = {
      ...createFastDependencies(),
      pollClaudeUsage: vi.fn(() => new Promise<Parameters<typeof resolveClaude>[0]>((resolve) => {
        resolveClaude = resolve;
      })),
    };
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const service = createUsageTrackingService({ logger, dependencies });

    service.start();
    await Promise.resolve();
    expect(dependencies.pollClaudeUsage).toHaveBeenCalledTimes(1);
    service.stop();
    const timeoutCallsAfterStop = setTimeoutSpy.mock.calls.length;

    resolveClaude({ windows: [], extraUsage: null, errors: [] });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(setTimeoutSpy).toHaveBeenCalledTimes(timeoutCallsAfterStop);
    service.dispose();
    setTimeoutSpy.mockRestore();
  });

  it("calls onUpdate when poll completes", async () => {
    const logger = createLogger();
    const onUpdate = vi.fn();
    const service = createUsageTrackingService({
      logger,
      onUpdate,
      dependencies: createFastDependencies(),
    });

    const snapshot = await service.poll();
    expect(snapshot).toBeDefined();
    expect(snapshot.lastPolledAt).toBeTruthy();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ lastPolledAt: expect.any(String) }));

    service.dispose();
  });

  it("notifies onUpdate after a GitHub-only background refresh completes", async () => {
    const logger = createLogger();
    const onUpdate = vi.fn();
    let resolveGithub!: (stats: {
      repo: string;
      available: boolean;
      fetchedAt: string;
      error: null;
      commitsCreated: number;
      prsTracked: number;
      prsOpen: number;
      prsMerged: number;
      prsClosed: number;
      prAdditions: number;
      prDeletions: number;
      filesChanged: number;
      daily: never[];
    }) => void;
    const scanGitHubStats = vi.fn(() => new Promise<Parameters<typeof resolveGithub>[0]>((resolve) => {
      resolveGithub = resolve;
    }));
    const service = createUsageTrackingService({
      logger,
      onUpdate,
      dependencies: {
        ...createFastDependencies(),
        scanGitHubStats,
      },
    });

    await service.poll();
    await service.refreshHistory();
    onUpdate.mockClear();

    await service.getAdeUsageStats({ preset: "7d" });
    await vi.waitFor(() => expect(scanGitHubStats).toHaveBeenCalledTimes(1));
    expect(onUpdate).not.toHaveBeenCalled();

    resolveGithub({
      repo: "arul28/ADE",
      available: true,
      fetchedAt: "2026-05-29T12:00:00.000Z",
      error: null,
      commitsCreated: 1,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: [],
    });

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    service.dispose();
  });

  it("notifies again when GitHub finishes after a combined background refresh", async () => {
    const logger = createLogger();
    const onUpdate = vi.fn();
    let resolveClaude!: (entries: never[]) => void;
    let resolveGithub!: (stats: {
      repo: string;
      available: boolean;
      fetchedAt: string;
      error: null;
      commitsCreated: number;
      prsTracked: number;
      prsOpen: number;
      prsMerged: number;
      prsClosed: number;
      prAdditions: number;
      prDeletions: number;
      filesChanged: number;
      daily: never[];
    }) => void;
    const dependencies = {
      ...createFastDependencies(),
      scanClaudeLogs: vi.fn(() => new Promise<never[]>((resolve) => {
        resolveClaude = resolve;
      })),
      scanGitHubStats: vi.fn(() => new Promise<Parameters<typeof resolveGithub>[0]>((resolve) => {
        resolveGithub = resolve;
      })),
    };
    const service = createUsageTrackingService({ logger, onUpdate, dependencies });

    await service.getAdeUsageStats({ preset: "7d" });
    await vi.waitFor(() => expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(dependencies.scanGitHubStats).toHaveBeenCalledTimes(1));

    resolveClaude([]);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));

    resolveGithub({
      repo: "arul28/ADE",
      available: true,
      fetchedAt: "2026-05-29T12:00:00.000Z",
      error: null,
      commitsCreated: 1,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: [],
    });

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    service.dispose();
  });
  it("does not scan local provider ledgers during automatic startup polls", async () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const service = createUsageTrackingService({
      logger,
      dependencies,
    });

    service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(dependencies.pollClaudeUsage).toHaveBeenCalledTimes(1);
    expect(dependencies.pollCodexUsage).toHaveBeenCalledTimes(1);
    expect(dependencies.scanClaudeLogs).not.toHaveBeenCalled();
    expect(dependencies.scanCodexLogs).not.toHaveBeenCalled();
    expect(dependencies.scanCursorLogs).not.toHaveBeenCalled();
    expect(dependencies.scanCursorAgentLogs).not.toHaveBeenCalled();
    expect(dependencies.scanOpenClawLogs).not.toHaveBeenCalled();
    expect(dependencies.scanOpenCodeLogs).not.toHaveBeenCalled();
    expect(dependencies.scanDroidLogs).not.toHaveBeenCalled();
    expect(dependencies.scanCopilotLogs).not.toHaveBeenCalled();
    expect(dependencies.scanGeminiLogs).not.toHaveBeenCalled();

    service.dispose();
  });

  it("calculates pacing separately for Claude and Codex windows", async () => {
    const now = Date.now();
    const weeklyResetMs = 3.5 * 24 * 60 * 60 * 1000;
    const weeklyReset = new Date(now + weeklyResetMs).toISOString();
    const windows = [
      { provider: "claude" as const, windowType: "weekly" as const, percentUsed: 40, resetsAt: weeklyReset, resetsInMs: weeklyResetMs },
      { provider: "codex" as const, windowType: "weekly" as const, percentUsed: 65, resetsAt: weeklyReset, resetsInMs: weeklyResetMs },
    ];

    const pacing = calculatePacingByProvider(windows);

    expect(pacing?.claude?.status).toBe("behind");
    expect(pacing?.codex?.status).toBe("far-ahead");
  });

  it("refreshHistory invalidates cost cache without coupling it to quota refresh", async () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const service = createUsageTrackingService({ logger, dependencies });

    const s1 = await service.refreshHistory();
    expect(s1).toBeDefined();
    expect(s1.lastPolledAt).toBeTruthy();
    expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanCodexLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanCursorLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanCursorAgentLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanOpenClawLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanOpenCodeLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanDroidLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanCopilotLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanGeminiLogs).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("keeps an explicit quota refresh responsive while a large history scan is pending", async () => {
    const logger = createLogger();
    let resolveSlowScan!: (entries: never[]) => void;
    const dependencies = {
      ...createFastDependencies(),
      scanClaudeLogs: vi.fn(() => new Promise<never[]>((resolve) => {
        resolveSlowScan = resolve;
      })),
    };
    const service = createUsageTrackingService({ logger, dependencies });

    const historyRefresh = service.refreshHistory();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(service.forceRefresh()).resolves.toBeDefined();
    expect(dependencies.pollClaudeUsage).toHaveBeenCalledTimes(1);
    expect(dependencies.pollCodexUsage).toHaveBeenCalledTimes(1);

    resolveSlowScan([]);
    await expect(historyRefresh).resolves.toBeDefined();
    service.dispose();
  });

  it("does not scan provider ledgers during an explicit quota-only refresh", async () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const service = createUsageTrackingService({ logger, dependencies });

    await service.forceRefresh();

    expect(dependencies.scanClaudeLogs).not.toHaveBeenCalled();
    expect(dependencies.scanCodexLogs).not.toHaveBeenCalled();
    expect(dependencies.scanCursorLogs).not.toHaveBeenCalled();
    expect(dependencies.scanGeminiLogs).not.toHaveBeenCalled();
    service.dispose();
  });

  it("caches a completed empty provider scan instead of rescanning on every stats read", async () => {
    const logger = createLogger();
    const dependencies = {
      ...createFastDependencies(),
      scanGitHubStats: vi.fn(async () => ({
        repo: "arul28/ADE",
        available: true,
        fetchedAt: new Date().toISOString(),
        error: null,
        commitsCreated: 0,
        prsTracked: 0,
        prsOpen: 0,
        prsMerged: 0,
        prsClosed: 0,
        prAdditions: 0,
        prDeletions: 0,
        filesChanged: 0,
        daily: [],
      })),
    };
    const service = createUsageTrackingService({ logger, dependencies });

    expect((await service.getAdeUsageStats({ preset: "7d" })).freshness?.state).toBe("refreshing");
    await vi.waitFor(() => expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(dependencies.scanGitHubStats).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect((await service.getAdeUsageStats({ preset: "7d" })).freshness?.state).toBe("fresh");
    await service.getAdeUsageStats({ preset: "7d" });
    expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("refreshes missing project costs from an established machine snapshot", async () => {
    const logger = createLogger();
    const cachedAt = new Date().toISOString();
    const dependencies = {
      ...createFastDependencies(),
      scanGitHubStats: vi.fn(async () => ({
        repo: "arul28/ADE",
        available: true,
        fetchedAt: cachedAt,
        error: null,
        commitsCreated: 0,
        prsTracked: 0,
        prsOpen: 0,
        prsMerged: 0,
        prsClosed: 0,
        prAdditions: 0,
        prDeletions: 0,
        filesChanged: 0,
        daily: [],
      })),
    };
    const cachedSnapshot = {
      version: _testing.USAGE_SNAPSHOT_CACHE_VERSION,
      snapshot: {
        windows: [],
        pacing: calculatePacing([]),
        pacingByProvider: {},
        providerStatus: {},
        costs: [{
          provider: "codex",
          last30dCostUsd: 1,
          todayCostUsd: 0,
          tokenBreakdown: {},
        }],
        adeCosts: [],
        extraUsage: [],
        costsLastPolledAt: cachedAt,
        lastPolledAt: cachedAt,
        errors: [],
      },
    };
    const previousVitest = process.env.VITEST;
    const previousNodeEnv = process.env.NODE_ENV;
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((() => (
      JSON.stringify(cachedSnapshot)
    )) as unknown as typeof fs.readFileSync);
    let service: ReturnType<typeof createUsageTrackingService>;
    try {
      process.env.VITEST = "false";
      process.env.NODE_ENV = "development";
      service = createUsageTrackingService({ logger, dependencies });
    } finally {
      readFileSync.mockRestore();
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    await service.getAdeUsageStats({ preset: "7d", scope: "machine" });
    await vi.waitFor(() => expect(dependencies.scanGitHubStats).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(dependencies.scanClaudeLogs).not.toHaveBeenCalled();

    const projectStats = await service.getAdeUsageStats({ preset: "7d", scope: "project" });
    expect(projectStats.freshness?.state).toBe("refreshing");
    await vi.waitFor(() => expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    await service.getAdeUsageStats({ preset: "7d", scope: "project" });
    expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(dependencies.scanGitHubStats).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));

    expect((await service.getAdeUsageStats({ preset: "7d", scope: "project" })).freshness?.state).toBe("fresh");
    expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  /**
   * The persisted snapshot is loaded straight into `cachedCosts`, and the cost
   * TTL only gates re-scanning — it never invalidates numbers a previous build
   * computed. So a build that changes the token math must be able to refuse the
   * old build's snapshot outright, or it keeps serving figures it no longer
   * believes (this is exactly how corrected Codex totals stayed hidden behind a
   * "updated 2d ago" header).
   */
  it("discards a persisted snapshot stamped with a different computation version", () => {
    const logger = createLogger();
    const cachedAt = new Date().toISOString();
    const cachedSnapshot = {
      version: _testing.USAGE_SNAPSHOT_CACHE_VERSION - 1,
      snapshot: {
        windows: [],
        pacing: calculatePacing([]),
        pacingByProvider: {},
        providerStatus: {},
        costs: [{
          provider: "codex",
          last30dCostUsd: 999,
          todayCostUsd: 0,
          tokenBreakdown: {},
        }],
        adeCosts: [],
        extraUsage: [],
        costsLastPolledAt: cachedAt,
        lastPolledAt: cachedAt,
        errors: [],
      },
    };
    const previousVitest = process.env.VITEST;
    const previousNodeEnv = process.env.NODE_ENV;
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((() => (
      JSON.stringify(cachedSnapshot)
    )) as unknown as typeof fs.readFileSync);
    let service: ReturnType<typeof createUsageTrackingService>;
    try {
      process.env.VITEST = "false";
      process.env.NODE_ENV = "development";
      service = createUsageTrackingService({ logger, dependencies: createFastDependencies() });
    } finally {
      readFileSync.mockRestore();
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    // No costs carried over, so the next read has to scan rather than reuse.
    expect(service.getUsageSnapshot()?.costs ?? []).toEqual([]);
    service.dispose();
  });

  it("preserves established costs and backs off failed project scans without blocking explicit refresh", async () => {
    const logger = createLogger();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const cachedAt = new Date(now).toISOString();
    const establishedCosts = [{
      provider: "codex" as const,
      last30dCostUsd: 1,
      todayCostUsd: 0,
      tokenBreakdown: {},
    }];
    const scanUsageLedgers = vi.fn()
      .mockRejectedValueOnce(new Error("automatic ledger worker failed"))
      .mockRejectedValueOnce(new Error("explicit ledger worker failed"))
      .mockResolvedValue({
        costs: [{
          provider: "codex" as const,
          last30dCostUsd: 2,
          todayCostUsd: 1,
          tokenBreakdown: {},
        }],
        projectCosts: [{
          provider: "codex" as const,
          last30dCostUsd: 0.5,
          todayCostUsd: 0.25,
          tokenBreakdown: {},
        }],
        daily7d: {},
        entryCounts: { codex: 1 },
        providerErrors: {},
      });
    const scanGitHubStats = vi.fn(async () => ({
      repo: "arul28/ADE",
      available: true,
      fetchedAt: cachedAt,
      error: null,
      commitsCreated: 0,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: [],
    }));
    const cachedSnapshot = {
      version: _testing.USAGE_SNAPSHOT_CACHE_VERSION,
      snapshot: {
        windows: [],
        pacing: calculatePacing([]),
        pacingByProvider: {},
        providerStatus: {},
        costs: establishedCosts,
        adeCosts: [],
        extraUsage: [],
        costsLastPolledAt: cachedAt,
        lastPolledAt: cachedAt,
        errors: [],
      },
    };
    const previousVitest = process.env.VITEST;
    const previousNodeEnv = process.env.NODE_ENV;
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((() => (
      JSON.stringify(cachedSnapshot)
    )) as unknown as typeof fs.readFileSync);
    let service: ReturnType<typeof createUsageTrackingService>;
    try {
      process.env.VITEST = "false";
      process.env.NODE_ENV = "development";
      service = createUsageTrackingService({
        logger,
        dependencies: {
          pollClaudeUsage: vi.fn(async () => ({ windows: [] as never[], extraUsage: null, errors: [] as never[] })),
          pollCodexUsage: vi.fn(async () => ({ windows: [] as never[], errors: [] as never[] })),
          scanUsageLedgers,
          scanGitHubStats,
        },
      });
    } finally {
      readFileSync.mockRestore();
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    try {
      expect((await service.getAdeUsageStats({ preset: "7d", scope: "project" })).freshness?.state).toBe("refreshing");
      await vi.waitFor(() => expect(scanUsageLedgers).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
        "usage.refresh.history_failed",
        expect.objectContaining({ reason: "automatic", failureCount: 1, retryDelayMs: 60_000 }),
      ));
      await new Promise((resolve) => setImmediate(resolve));

      expect(service.getUsageSnapshot()).toMatchObject({
        costs: establishedCosts,
        costsLastPolledAt: cachedAt,
      });
      expect((await service.getAdeUsageStats({ preset: "7d", scope: "machine" })).freshness?.state).toBe("fresh");
      expect((await service.getAdeUsageStats({ preset: "7d", scope: "project" })).freshness?.state).toBe("stale");
      await service.getAdeUsageStats({ preset: "7d", scope: "project" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(scanUsageLedgers).toHaveBeenCalledTimes(1);

      await expect(service.refreshHistory()).rejects.toThrow("explicit ledger worker failed");
      expect(scanUsageLedgers).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        "usage.refresh.history_failed",
        expect.objectContaining({ reason: "user", failureCount: 2, retryDelayMs: 120_000 }),
      );
      expect(service.getUsageSnapshot()).toMatchObject({
        costs: establishedCosts,
        costsLastPolledAt: cachedAt,
      });

      await service.getAdeUsageStats({ preset: "7d", scope: "project" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(scanUsageLedgers).toHaveBeenCalledTimes(2);

      nowSpy.mockReturnValue(now + 2 * 60_000);
      expect((await service.getAdeUsageStats({ preset: "7d", scope: "project" })).freshness?.state).toBe("refreshing");
      await vi.waitFor(() => expect(scanUsageLedgers).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setImmediate(resolve));
      await service.getAdeUsageStats({ preset: "7d", scope: "project" });
      await vi.waitFor(() => expect(scanGitHubStats).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setImmediate(resolve));
      expect((await service.getAdeUsageStats({ preset: "7d", scope: "project" })).freshness?.state).toBe("fresh");
    } finally {
      service.dispose();
      nowSpy.mockRestore();
    }
  });

  it("serves aged provider history without launching a surprise transcript rescan", async () => {
    const logger = createLogger();
    const now = new Date("2026-07-22T12:00:00.000Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const dependencies = {
      ...createFastDependencies(),
      scanGitHubStats: vi.fn(async () => ({
        repo: null,
        available: false,
        fetchedAt: null,
        error: null,
        commitsCreated: 0,
        prsTracked: 0,
        prsOpen: 0,
        prsMerged: 0,
        prsClosed: 0,
        prAdditions: 0,
        prDeletions: 0,
        filesChanged: 0,
        daily: [],
      })),
    };
    const service = createUsageTrackingService({ logger, dependencies });
    await service.refreshHistory();
    for (const scanner of [
      dependencies.scanClaudeLogs,
      dependencies.scanCodexLogs,
      dependencies.scanCursorLogs,
      dependencies.scanCursorAgentLogs,
      dependencies.scanOpenClawLogs,
      dependencies.scanOpenCodeLogs,
      dependencies.scanDroidLogs,
      dependencies.scanCopilotLogs,
      dependencies.scanGeminiLogs,
    ]) scanner.mockClear();

    nowSpy.mockReturnValue(now + 2 * 60 * 60_000);
    const stats = await service.getAdeUsageStats({ preset: "7d" });
    expect(stats.freshness?.state).toBe("refreshing");
    await vi.waitFor(() => expect(dependencies.scanGitHubStats).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    const settled = await service.getAdeUsageStats({ preset: "7d" });
    expect(settled.freshness?.state).toBe("stale");
    for (const scanner of [
      dependencies.scanClaudeLogs,
      dependencies.scanCodexLogs,
      dependencies.scanCursorLogs,
      dependencies.scanCursorAgentLogs,
      dependencies.scanOpenClawLogs,
      dependencies.scanOpenCodeLogs,
      dependencies.scanDroidLogs,
      dependencies.scanCopilotLogs,
      dependencies.scanGeminiLogs,
    ]) expect(scanner).not.toHaveBeenCalled();

    service.dispose();
    nowSpy.mockRestore();
  });

  it("runs an explicit history scan independently from a pending startup quota poll", async () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    let resolveStartupPoll!: (value: { windows: never[]; extraUsage: null; errors: never[] }) => void;
    dependencies.pollClaudeUsage
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveStartupPoll = resolve;
      }))
      .mockResolvedValue({ windows: [] as never[], extraUsage: null, errors: [] as never[] });
    const service = createUsageTrackingService({ logger, dependencies });

    service.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(dependencies.pollClaudeUsage).toHaveBeenCalledTimes(1);

    const refresh = service.refreshHistory();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(refresh).resolves.toBeDefined();
    expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanCodexLogs).toHaveBeenCalledTimes(1);

    resolveStartupPoll({ windows: [] as never[], extraUsage: null, errors: [] as never[] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(dependencies.pollClaudeUsage).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("widens custom ranges to local days for providers, database stats, and GitHub stats", async () => {
    const since = new Date(2026, 6, 1, 12, 0, 0, 0);
    const until = new Date(2026, 6, 2, 12, 0, 0, 0);
    const expectedSince = new Date(2026, 6, 1, 0, 0, 0, 0).toISOString();
    const expectedUntil = new Date(2026, 6, 2, 23, 59, 59, 999).toISOString();
    const collectDatabaseStats = vi.fn(() => null);
    const logger = createLogger();
    const scanGitHubStats = vi.fn(async (range: any) => ({
      repo: "arul28/ADE",
      available: true,
      fetchedAt: range.until,
      error: null,
      commitsCreated: 0,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: [],
    }));
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        ...createFastDependencies(),
        scanCodexLogs: vi.fn(async () => [
          {
            messageId: "before-since-on-boundary-day",
            model: "gpt-5.5",
            originator: "codex_cli_rs",
            inputTokens: 70,
            outputTokens: 30,
            cachedTokens: 0,
            timestamp: new Date(2026, 6, 1, 8, 0, 0, 0).getTime(),
          },
          {
            messageId: "after-until-on-boundary-day",
            model: "gpt-5.5",
            originator: "codex_cli_rs",
            inputTokens: 150,
            outputTokens: 50,
            cachedTokens: 0,
            timestamp: new Date(2026, 6, 2, 20, 0, 0, 0).getTime(),
          },
          {
            messageId: "outside-range",
            model: "gpt-5.5",
            originator: "codex_cli_rs",
            inputTokens: 400,
            outputTokens: 0,
            cachedTokens: 0,
            timestamp: new Date(2026, 6, 3, 12, 0, 0, 0).getTime(),
          },
        ]),
        scanGitHubStats,
        collectDatabaseStats,
      },
    });

    await service.refreshHistory();
    const stats = await service.getAdeUsageStats({
      preset: "all",
      since: since.toISOString(),
      until: until.toISOString(),
    });

    expect(stats.range).toEqual({
      preset: "all",
      since: expectedSince,
      until: expectedUntil,
    });
    expect(collectDatabaseStats).toHaveBeenCalledWith(stats.range);
    expect(scanGitHubStats).toHaveBeenCalledWith(stats.range);
    expect(stats.providers.find((provider) => provider.provider === "codex")?.totalTokens).toBe(300);

    service.dispose();
  });

  it("shares a GitHub stats cache entry across custom times on the same local days", async () => {
    const logger = createLogger();
    const scanGitHubStats = vi.fn(async (range: any) => ({
      repo: "arul28/ADE",
      available: true,
      fetchedAt: range.until,
      error: null,
      commitsCreated: 1,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: [],
    }));
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        ...createFastDependencies(),
        scanGitHubStats,
      },
    });

    await service.getAdeUsageStats({
      preset: "today",
      since: new Date(2026, 4, 30, 8).toISOString(),
      until: new Date(2026, 4, 30, 10).toISOString(),
    });
    await vi.waitFor(() => expect(scanGitHubStats).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    const stats = await service.getAdeUsageStats({
      preset: "today",
      since: new Date(2026, 4, 30, 9).toISOString(),
      until: new Date(2026, 4, 30, 11).toISOString(),
    });

    expect(stats.githubActivity?.commits).toBe(1);
    expect(scanGitHubStats).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("clamps inverted custom ranges before scanning GitHub stats", async () => {
    const logger = createLogger();
    const laterDay = new Date(2026, 4, 31, 12, 0, 0, 0);
    const earlierDay = new Date(2026, 4, 30, 12, 0, 0, 0);
    const scanGitHubStats = vi.fn(async () => ({
      repo: "arul28/ADE",
      available: true,
      fetchedAt: null,
      error: null,
      commitsCreated: 0,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: [],
    }));
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        ...createFastDependencies(),
        scanGitHubStats,
      },
    });

    await service.getAdeUsageStats({
      preset: "7d",
      since: laterDay.toISOString(),
      until: earlierDay.toISOString(),
    });

    expect(scanGitHubStats).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date(2026, 4, 30, 0, 0, 0, 0).toISOString(),
      until: new Date(2026, 4, 30, 23, 59, 59, 999).toISOString(),
    }));

    service.dispose();
  });

  it("counts all Codex ledger entries in the full Codex runtime total", async () => {
    const logger = createLogger();
    const now = Date.now();
    const dependencies = {
      ...createFastDependencies(),
      scanCodexLogs: vi.fn(async () => [
        {
          messageId: "codex-local",
          model: "gpt-5.5",
          originator: "codex_cli_rs",
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          billableCachedTokens: 20,
          cacheWriteTokens: 0,
          timestamp: now,
        },
        {
          messageId: "codex-ade",
          model: "gpt-5.5",
          originator: "ade",
          inputTokens: 50,
          outputTokens: 10,
          cachedTokens: 20,
          billableCachedTokens: 10,
          cacheWriteTokens: 0,
          timestamp: now,
        },
      ] as any),
      scanGitHubStats: vi.fn(async () => ({
        repo: null,
        available: false,
        fetchedAt: null,
        error: null,
        commitsCreated: 0,
        prsTracked: 0,
        prsOpen: 0,
        prsMerged: 0,
        prsClosed: 0,
        prAdditions: 0,
        prDeletions: 0,
        filesChanged: 0,
        daily: [],
      })),
    };
    const service = createUsageTrackingService({ logger, dependencies });

    const snapshot = await service.refreshHistory();

    expect(snapshot.costs.find((cost) => cost.provider === "codex")?.tokenBreakdownByPreset?.today?.["gpt-5.5"]).toMatchObject({
      input: 150,
      output: 30,
      cached: 60,
    });
    expect(snapshot.adeCosts).toEqual([]);
    expect(snapshot.costs.find((cost) => cost.provider === "codex")?.adeOriginatedTokensByPreset?.today).toBe(80);
    const stats = await service.getAdeUsageStats({ preset: "today" });
    expect(stats.providers.find((provider) => provider.provider === "codex")).toMatchObject({
      adeOriginatedTokens: 80,
      externalTokens: 160,
    });

    service.dispose();
  });

  it("project scope filters ledgers without rescanning and excludes unsupported totals", async () => {
    const logger = createLogger();
    const now = Date.now();
    const dependencies = {
      ...createFastDependencies(),
      scanClaudeLogs: vi.fn(async () => [
        {
          messageId: "project",
          model: "claude-opus-4-6",
          projectPath: "/repo/.ade/worktrees/lane-a",
          adeOriginated: true,
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          timestamp: now,
        },
        {
          messageId: "other",
          model: "claude-opus-4-6",
          projectPath: "/other/repo",
          inputTokens: 20,
          outputTokens: 10,
          cachedTokens: 0,
          timestamp: now,
        },
      ] as any),
      scanCursorLogs: vi.fn(async () => [{
        messageId: "cursor-machine-only",
        model: "cursor-auto",
        inputTokens: 30,
        outputTokens: 10,
        cachedTokens: 0,
        timestamp: now,
      }] as any),
      scanGitHubStats: vi.fn(async () => ({
        repo: null,
        available: false,
        fetchedAt: null,
        error: null,
        commitsCreated: 0,
        prsTracked: 0,
        prsOpen: 0,
        prsMerged: 0,
        prsClosed: 0,
        prAdditions: 0,
        prDeletions: 0,
        filesChanged: 0,
        daily: [],
      })),
    };
    const service = createUsageTrackingService({ logger, dependencies, projectRoot: "/repo" });
    await service.refreshHistory();

    const machine = await service.getAdeUsageStats({ preset: "today", scope: "machine" });
    const project = await service.getAdeUsageStats({ preset: "today", scope: "project" });

    expect(machine.scope).toBe("machine");
    expect(machine.summary.observedProviderTokens).toBe(85);
    expect(machine.providers.find((provider) => provider.provider === "claude")).toMatchObject({
      totalTokens: 45,
      adeOriginatedTokens: 15,
      externalTokens: 30,
      scopeSupported: true,
    });
    expect(project.scope).toBe("project");
    expect(project.summary.observedProviderTokens).toBe(15);
    expect(project.providers.find((provider) => provider.provider === "claude")).toMatchObject({
      totalTokens: 15,
      adeOriginatedTokens: 15,
      externalTokens: 0,
      scopeSupported: true,
    });
    expect(project.providers.find((provider) => provider.provider === "cursor")).toMatchObject({
      totalTokens: 0,
      scopeSupported: false,
      estimation: "mixed",
    });
    expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanCursorLogs).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("sets estimation flags on provider snapshots and summaries", async () => {
    const logger = createLogger();
    const now = Date.now();
    const tokenEntry = (messageId: string, model: string, estimation?: "chars" | "mixed" | "distribution") => ({
      messageId,
      model,
      inputTokens: 8,
      outputTokens: 2,
      cachedTokens: 0,
      timestamp: now,
      ...(estimation ? { estimation } : {}),
    });
    const dependencies = {
      ...createFastDependencies(),
      scanClaudeLogs: vi.fn(async () => [tokenEntry("claude", "claude-opus-4-6")] as any),
      scanCursorLogs: vi.fn(async () => [tokenEntry("cursor", "cursor-auto")] as any),
      scanCursorAgentLogs: vi.fn(async () => [tokenEntry("cursor-agent", "cursor-agent-auto", "chars")] as any),
      scanDroidLogs: vi.fn(async () => [tokenEntry("droid", "droid-auto", "distribution")] as any),
      scanCopilotLogs: vi.fn(async () => [tokenEntry("copilot", "copilot-auto", "chars")] as any),
      scanGitHubStats: vi.fn(async () => ({
        repo: null,
        available: false,
        fetchedAt: null,
        error: null,
        commitsCreated: 0,
        prsTracked: 0,
        prsOpen: 0,
        prsMerged: 0,
        prsClosed: 0,
        prAdditions: 0,
        prDeletions: 0,
        filesChanged: 0,
        daily: [],
      })),
    };
    const service = createUsageTrackingService({ logger, dependencies });
    const snapshot = await service.refreshHistory();
    const snapshotFlags = Object.fromEntries(snapshot.costs.map((cost) => [cost.provider, cost.estimation]));
    expect(snapshotFlags).toMatchObject({
      cursor: "mixed",
      "cursor-agent": "chars",
      droid: "distribution",
      copilot: "chars",
    });
    expect(snapshotFlags.claude).toBeUndefined();

    const stats = await service.getAdeUsageStats({ preset: "today" });
    const summaryFlags = Object.fromEntries(stats.providers.map((provider) => [provider.provider, provider.estimation]));
    expect(summaryFlags).toMatchObject(snapshotFlags);

    service.dispose();
  });

  it("does not crash when onUpdate callback throws", async () => {
    const logger = createLogger();
    const onUpdate = vi.fn(() => {
      throw new Error("callback boom");
    });
    const service = createUsageTrackingService({
      logger,
      onUpdate,
      dependencies: createFastDependencies(),
    });

    // Should not throw
    const snapshot = await service.poll();
    expect(snapshot).toBeDefined();

    service.dispose();
  });

  it("prevents concurrent polls", async () => {
    const logger = createLogger();
    const service = createUsageTrackingService({
      logger,
      dependencies: createFastDependencies(),
    });

    // Fire two polls concurrently
    const [s1, s2] = await Promise.all([service.poll(), service.poll()]);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();

    service.dispose();
  });

});

// ── Local Cost Scanning with real files ──────────────────────────

describe("scanClaudeLogs (via aggregateCosts)", () => {
  it("creates correct breakdown from synthetic token entries", () => {
    const now = Date.now();
    const entries = [
      {
        messageId: "msg1:req1",
        model: "claude-3-5-sonnet-20250101",
        inputTokens: 5000,
        outputTokens: 2000,
        cachedTokens: 1000,
        timestamp: now - 60_000,
      },
      {
        messageId: "msg2:req2",
        model: "claude-opus-4",
        inputTokens: 3000,
        outputTokens: 1500,
        cachedTokens: 500,
        timestamp: now - 120_000,
      },
    ];

    const cost = aggregateCosts(entries, "claude");
    expect(cost.provider).toBe("claude");
    expect(Object.keys(cost.tokenBreakdown)).toHaveLength(2);
    expect(cost.tokenBreakdown["claude-3-5-sonnet-20250101"]!.input).toBe(5000);
    expect(cost.tokenBreakdown["claude-opus-4"]!.output).toBe(1500);
    expect(cost.last30dCostUsd).toBeGreaterThan(0);
  });

  it("discovers Claude projects from CLAUDE_CONFIG_DIRS", async () => {
    const tmpDir = makeTmpDir();
    const staleDir = path.join(tmpDir, "missing");
    const configDir = path.join(tmpDir, "claude-config");
    const projectDir = path.join(configDir, "projects", "project-a");
    const originalConfigDirs = process.env.CLAUDE_CONFIG_DIRS;
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "session-1.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-05-29T12:00:00.000Z",
            message: {
              id: "msg-1",
              model: "claude-opus-4-6",
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_read_input_tokens: 30,
                cache_creation_input_tokens: 5,
              },
            },
          }),
          "",
        ].join("\n"),
      );

      process.env.CLAUDE_CONFIG_DIRS = [staleDir, configDir].join(path.delimiter);
      delete process.env.CLAUDE_CONFIG_DIR;

      const discoveredProjectDirs = await discoverClaudeProjectDirs();
      expect(discoveredProjectDirs.map((value) => path.resolve(value))).toContain(path.resolve(projectDir));

      const entries = await scanClaudeLogs([projectDir]);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        messageId: "msg-1",
        model: "claude-opus-4-6",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 30,
        cacheWriteTokens: 5,
      });
    } finally {
      if (originalConfigDirs === undefined) {
        delete process.env.CLAUDE_CONFIG_DIRS;
      } else {
        process.env.CLAUDE_CONFIG_DIRS = originalConfigDirs;
      }
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deduplicates Claude message ids across files", async () => {
    const tmpDir = makeTmpDir();
    const projectDir = path.join(tmpDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      const assistant = (timestamp: string) => JSON.stringify({
        type: "assistant",
        timestamp,
        cwd: "/repo",
        message: {
          id: "msg-shared",
          model: "claude-opus-4-6",
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      });
      fs.writeFileSync(path.join(projectDir, "session-a.jsonl"), `${assistant("2026-05-29T12:00:00.000Z")}\n`);
      fs.writeFileSync(path.join(projectDir, "session-b.jsonl"), `${assistant("2026-05-29T12:01:00.000Z")}\n`);

      const entries = await scanClaudeLogs([projectDir]);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.messageId).toBe("msg-shared");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the last Claude streaming partial at the first timestamp", async () => {
    const tmpDir = makeTmpDir();
    const projectDir = path.join(tmpDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      const firstTimestamp = "2026-05-29T12:00:00.000Z";
      fs.writeFileSync(
        path.join(projectDir, "session.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: firstTimestamp,
            cwd: "/repo",
            message: { id: "msg-stream", model: "claude-opus-4-6", usage: { input_tokens: 10, output_tokens: 2 } },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-05-29T12:00:03.000Z",
            cwd: "/repo",
            message: { id: "msg-stream", model: "claude-opus-4-6", usage: { input_tokens: 25, output_tokens: 8 } },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanClaudeLogs([projectDir]);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ inputTokens: 25, outputTokens: 8 });
      expect(entries[0]?.timestamp).toBe(Date.parse(firstTimestamp));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("attributes Claude sessions launched from ADE worktrees", async () => {
    const tmpDir = makeTmpDir();
    const projectDir = path.join(tmpDir, "projects", "-repo--ade-worktrees-lane");
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(projectDir, "session.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          cwd: "/repo/.ade/worktrees/lane",
          message: {
            id: "msg-ade",
            model: "claude-opus-4-6",
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        })}\n`,
      );

      const entries = await scanClaudeLogs([projectDir]);
      const cost = aggregateCosts(entries, "claude");

      expect(entries[0]).toMatchObject({
        projectPath: "/repo/.ade/worktrees/lane",
        adeOriginated: true,
      });
      expect(cost.adeOriginatedTokensByPreset?.today).toBe(12);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("scan completeness", () => {
    /**
     * Every failure in the ledger scanners is swallowed so a flaky file cannot
     * blank the page. The cross-machine dedupe needs the opposite: it compares
     * per-day token totals against a peer's and reads "content on one side the
     * other could not possibly have" as proof the two read different files. A
     * directory that would not list makes exactly that shape, so the scan has
     * to say it read less than it set out to.
     */
    function makeProjectDir(tmpDir: string, name: string): string {
      const projectDir = path.join(tmpDir, name);
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "session.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-29T12:00:00.000Z",
          message: { id: `msg-${name}`, model: "claude-opus-4-6", usage: { input_tokens: 10, output_tokens: 2 } },
        })}\n`,
      );
      return projectDir;
    }

    it("reports a directory it could not list as an incomplete read", async () => {
      const tmpDir = makeTmpDir();
      try {
        const readable = makeProjectDir(tmpDir, "readable");
        const blocked = makeProjectDir(tmpDir, "blocked");
        const realReaddir = fs.promises.readdir.bind(fs.promises);
        vi.spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike, options: unknown) => {
          if (path.resolve(String(target)) === path.resolve(blocked)) {
            const error: NodeJS.ErrnoException = new Error("permission denied");
            error.code = "EACCES";
            throw error;
          }
          return realReaddir(target as string, options as never);
        }) as typeof fs.promises.readdir);

        const partial = await runLedgerScanWithCompleteness(() => scanClaudeLogs([readable, blocked]));
        // The readable half still counts — the page must not go blank — but the
        // provider is no longer something this machine can be compared on.
        expect(partial.value).toHaveLength(1);
        expect(partial.complete).toBe(false);

        vi.restoreAllMocks();
        const whole = await runLedgerScanWithCompleteness(() => scanClaudeLogs([readable, blocked]));
        expect(whole.value).toHaveLength(2);
        expect(whole.complete).toBe(true);
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("treats an absent directory as read in full, not as an incomplete read", async () => {
      // The other failure direction: a provider that was never installed, and
      // the optional subtrees almost no project has, are absent on every
      // machine. Counting those as incompleteness would mark every provider
      // incomplete, empty the compared provider set, and leave the dedupe
      // unable to tell a clone from a shared mount.
      const tmpDir = makeTmpDir();
      try {
        const readable = makeProjectDir(tmpDir, "readable");
        const scan = await runLedgerScanWithCompleteness(() => (
          scanClaudeLogs([readable, path.join(tmpDir, "never-existed")])
        ));
        expect(scan.value).toHaveLength(1);
        expect(scan.complete).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("separates a provider that was never installed from one whose root is there", () => {
      // What the worker uses to tell a genuinely empty provider from the silent
      // half of a partial read, when nothing threw at all.
      const tmpDir = makeTmpDir();
      try {
        const roots = { present: [tmpDir], absent: [path.join(tmpDir, "never-existed")] };
        expect(usageLedgerTranscriptRootExists("present", roots)).toBe(true);
        expect(usageLedgerTranscriptRootExists("absent", roots)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("treats a provider with no root mapping as suspect, not as uninstalled", () => {
      // `false` here means "genuinely not installed, so an empty scan is
      // truthful" — and a provider missing from the map has proven nothing of
      // the sort. It means nobody taught this function where that provider
      // keeps its transcripts, which is exactly when an empty scan is least
      // trustworthy, so the provider must keep its incompleteness signal.
      expect(usageLedgerTranscriptRootExists("provider-nobody-mapped", { claude: [] })).toBe(true);
    });

    it("maps every provider the worker scans", () => {
      // The mismatch the guard above covers for: a scanner slug that is not a
      // key in the roots map silently loses its scan-completeness signal.
      const roots = usageLedgerTranscriptRoots();
      const unmapped = providerScanners
        .map((scanner) => scanner.provider)
        .filter((provider) => !roots[provider]);
      expect(unmapped).toEqual([]);
    });
  });
});

describe("scanCodexLogs", () => {
  it("skips an oversized record and processes the following token record", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "07", "12");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "rollout-test.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-07-12T12:00:00.000Z",
            type: "session_meta",
            payload: { id: "session-1", originator: "codex_cli_rs", model: "gpt-5.5" },
          }),
          JSON.stringify({
            timestamp: "2026-07-12T12:00:01.000Z",
            type: "response_item",
            payload: { type: "function_call_output", output: "x".repeat(2_048) },
          }),
          JSON.stringify({
            timestamp: "2026-07-12T12:00:02.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
                last_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
              },
            },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanCodexLogs({ maxJsonlLineBytes: 1_024 });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        // Key namespace:cumulativeTotal:input:cached:output:reasoning — no
        // timestamp, because forks re-timestamp the parent history they replay.
        messageId: "codex:session-1:15:12:0:3:0",
        model: "gpt-5.5",
        inputTokens: 12,
        outputTokens: 3,
      });
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent production history scans", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "07", "12");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "rollout-test.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-07-12T12:00:00.000Z",
            type: "session_meta",
            payload: { id: "session-coalesced", originator: "codex_cli_rs", model: "gpt-5.5" },
          }),
          JSON.stringify({
            timestamp: "2026-07-12T12:00:01.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
                last_token_usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
              },
            },
          }),
          "",
        ].join("\n"),
      );

      const first = scanCodexLogs();
      const second = scanCodexLogs();

      // Identity of the resolved value, not of the promise: each caller gets a
      // thin wrapper so it can inherit the shared scan's completeness in its
      // own async context. One scan, one entry set, two handles to it.
      const [firstEntries, secondEntries] = await Promise.all([first, second]);
      expect(secondEntries).toBe(firstEntries);
      expect(firstEntries).toHaveLength(1);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("selects newest ledger files within per-file and aggregate byte budgets", async () => {
    const tmpDir = makeTmpDir();
    try {
      const writeCandidate = (name: string, bytes: number, ageSeconds: number) => {
        const filePath = path.join(tmpDir, name);
        fs.writeFileSync(filePath, Buffer.alloc(bytes, 0x78));
        const modifiedAt = new Date(Date.now() - ageSeconds * 1_000);
        fs.utimesSync(filePath, modifiedAt, modifiedAt);
        return filePath;
      };
      writeCandidate("old.jsonl", 700, 30);
      const middle = writeCandidate("middle.jsonl", 700, 20);
      const newest = writeCandidate("newest.jsonl", 700, 10);
      writeCandidate("too-large.jsonl", 1_500, 1);

      const selected = await findRecentFiles(tmpDir, 3650, [".jsonl"], {
        maxFiles: 10,
        maxFileBytes: 1_000,
        maxTotalBytes: 1_400,
      });

      expect(selected).toEqual([newest, middle]);
      expect(selected).not.toContain(path.join(tmpDir, "old.jsonl"));
      expect(selected).not.toContain(path.join(tmpDir, "too-large.jsonl"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("parses modern token_count events from Codex session logs", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "05", "29");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "rollout-2026-05-29T12-00-00-test.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-05-29T12:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "session-1",
              originator: "codex_cli_rs",
              cwd: "/repo",
              model: "gpt-5.5",
            },
          }),
          JSON.stringify({
            timestamp: "2026-05-29T12:00:01.000Z",
            type: "turn_context",
            payload: { model: "gpt-5.5" },
          }),
          JSON.stringify({
            timestamp: "2026-05-29T12:00:02.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                // Codex counts reasoning INSIDE output_tokens, so the totals
                // add up to input + output with no separate reasoning term.
                // This fixture previously used 1300 (input + output +
                // reasoning), which no real Codex record does.
                total_token_usage: {
                  input_tokens: 1200,
                  cached_input_tokens: 300,
                  output_tokens: 80,
                  reasoning_output_tokens: 20,
                  total_tokens: 1280,
                },
                last_token_usage: {
                  input_tokens: 1200,
                  cached_input_tokens: 300,
                  output_tokens: 80,
                  reasoning_output_tokens: 20,
                  total_tokens: 1280,
                },
              },
            },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanCodexLogs();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        model: "gpt-5.5",
        inputTokens: 900,
        billableInputTokens: 900,
        outputTokens: 80,
        // Not 100: reasoning is already inside Codex's output_tokens, so
        // adding it billed every reasoning token twice.
        billableOutputTokens: 80,
        cachedTokens: 300,
        billableCachedTokens: 300,
      });
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("counts a compact boundary once when no cumulative total is reported", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "05", "29");
      fs.mkdirSync(sessionDir, { recursive: true });
      // A compact-boundary token_count carries only `last_token_usage`, so its
      // cumulative total reads as 0 on EVERY event. A duplicate guard that only
      // fires when the total is above zero counts each boundary twice.
      const compactEvent = (timestamp: string) => JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 40 } },
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "rollout-2026-05-29T12-00-00-compact.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-05-29T12:00:00.000Z",
            type: "session_meta",
            payload: { id: "session-compact", originator: "codex_cli_rs", cwd: "/repo", model: "gpt-5.5" },
          }),
          compactEvent("2026-05-29T12:00:01.000Z"),
          compactEvent("2026-05-29T12:00:02.000Z"),
          compactEvent("2026-05-29T12:00:03.000Z"),
          "",
        ].join("\n"),
      );

      const entries = await scanCodexLogs();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ inputTokens: 400, cachedTokens: 100, outputTokens: 40 });
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("drops a fork's re-timestamped replay of its parent's token history", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "05", "29");
      fs.mkdirSync(sessionDir, { recursive: true });
      const tokenEvent = (timestamp: string, total: {
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
        reasoning_output_tokens: number;
        total_tokens: number;
      }, last: Record<string, number>) => JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
      });
      const parentTurn1 = {
        total: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1060 },
        last: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10 },
      };
      const parentTurn2 = {
        total: { input_tokens: 3000, cached_input_tokens: 900, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 3150 },
        last: { input_tokens: 2000, cached_input_tokens: 700, output_tokens: 70, reasoning_output_tokens: 20 },
      };
      fs.writeFileSync(
        path.join(sessionDir, "rollout-2026-05-29T12-00-00-parent.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-05-29T12:00:00.000Z",
            type: "session_meta",
            payload: { id: "session-parent", originator: "codex_cli_rs", cwd: "/repo", model: "gpt-5.5" },
          }),
          tokenEvent("2026-05-29T12:00:01.000Z", parentTurn1.total, parentTurn1.last),
          tokenEvent("2026-05-29T12:00:02.000Z", parentTurn2.total, parentTurn2.last),
          "",
        ].join("\n"),
      );
      // The fork copies the parent's whole history under NEW timestamps, then
      // does one turn of genuinely new work. Only the new turn may be counted.
      fs.writeFileSync(
        path.join(sessionDir, "rollout-2026-05-29T13-00-00-fork.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-05-29T13:00:00.000Z",
            type: "session_meta",
            payload: { id: "session-fork", forked_from_id: "session-parent", originator: "codex_cli_rs", cwd: "/repo", model: "gpt-5.5" },
          }),
          tokenEvent("2026-05-29T13:00:01.000Z", parentTurn1.total, parentTurn1.last),
          tokenEvent("2026-05-29T13:00:02.000Z", parentTurn2.total, parentTurn2.last),
          tokenEvent(
            "2026-05-29T13:00:03.000Z",
            { input_tokens: 4000, cached_input_tokens: 1200, output_tokens: 160, reasoning_output_tokens: 40, total_tokens: 4200 },
            { input_tokens: 1000, cached_input_tokens: 300, output_tokens: 40, reasoning_output_tokens: 10 },
          ),
          "",
        ].join("\n"),
      );

      const entries = await scanCodexLogs();

      const totals = entries.reduce((sum, entry) => ({
        input: sum.input + entry.inputTokens,
        cached: sum.cached + entry.cachedTokens,
        output: sum.output + entry.outputTokens,
      }), { input: 0, cached: 0, output: 0 });
      // Parent turn 1 + parent turn 2 + the fork's one new turn — the replay is
      // gone even though every replayed event carries a different timestamp.
      expect(entries).toHaveLength(3);
      expect(totals).toEqual({ input: 800 + 1300 + 700, cached: 200 + 700 + 300, output: 50 + 70 + 40 });
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes Codex archived session ledgers in lifetime usage", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const archivedDir = path.join(tmpDir, "archived_sessions");
      fs.mkdirSync(archivedDir, { recursive: true });
      fs.writeFileSync(
        path.join(archivedDir, "archived.jsonl"),
        [
          JSON.stringify({
            timestamp: "2025-08-01T12:00:00.000Z",
            type: "session_meta",
            payload: { id: "archived-1", originator: "codex_cli_rs", model: "gpt-5.5" },
          }),
          JSON.stringify({
            timestamp: "2025-08-01T12:00:01.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
                last_token_usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
              },
            },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanCodexLogs();

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ inputTokens: 20, outputTokens: 3 });
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it("includes Codex ADE sessions and attributes their origin", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "05", "29");
      fs.mkdirSync(sessionDir, { recursive: true });
      const writeSession = (originator: string, file: string) => {
        fs.writeFileSync(
          path.join(sessionDir, file),
          [
            JSON.stringify({
              timestamp: "2026-05-29T12:00:00.000Z",
              type: "session_meta",
              payload: { id: file, originator, cwd: "/repo", model: "gpt-5.5" },
            }),
            JSON.stringify({
              timestamp: "2026-05-29T12:00:01.000Z",
              type: "event_msg",
              payload: {
                type: "token_count",
                info: {
                  total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                  last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                },
              },
            }),
            "",
          ].join("\n"),
        );
      };
      writeSession("codex_cli_rs", "rollout-2026-05-29T12-00-00-codex.jsonl");
      writeSession("Codex Desktop", "rollout-2026-05-29T12-00-02-desktop.jsonl");
      writeSession("ade", "rollout-2026-05-29T12-00-01-ade.jsonl");
      writeSession("ade_desktop", "rollout-2026-05-29T12-00-03-ade-desktop.jsonl");

      const entries = await scanCodexLogs();

      expect(entries).toHaveLength(4);
      expect(entries.filter((entry) => entry.adeOriginated)).toHaveLength(2);
      expect(entries.map((entry) => entry.originator).sort()).toEqual([
        "Codex Desktop",
        "ade",
        "ade_desktop",
        "codex_cli_rs",
      ]);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores Codex fork replay while preserving genuine cumulative deltas", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "05", "29");
      fs.mkdirSync(sessionDir, { recursive: true });
      const usageEvent = (timestamp: string, totalInput: number, totalOutput: number, lastInput: number, lastOutput: number) => JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: totalInput,
              output_tokens: totalOutput,
              total_tokens: totalInput + totalOutput,
            },
            last_token_usage: {
              input_tokens: lastInput,
              output_tokens: lastOutput,
              total_tokens: lastInput + lastOutput,
            },
          },
        },
      });
      fs.writeFileSync(
        path.join(sessionDir, "parent.jsonl"),
        [
          JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: "/repo", originator: "codex_cli_rs" } }),
          usageEvent("2026-05-29T12:00:00.000Z", 10, 2, 10, 2),
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(sessionDir, "fork.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: "fork", forked_from_id: "parent", cwd: "/repo", originator: "codex_cli_rs" },
          }),
          usageEvent("2026-05-29T12:01:00.000Z", 10, 2, 10, 2),
          usageEvent("2026-05-29T12:02:00.000Z", 15, 2, 5, 0),
          "",
        ].join("\n"),
      );

      const entries = await scanCodexLogs();

      expect(entries).toHaveLength(2);
      expect(entries.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(15);
      expect(entries.reduce((sum, entry) => sum + entry.outputTokens, 0)).toBe(2);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips oversized Codex session files during local usage scans", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmpDir;
      const sessionDir = path.join(tmpDir, "sessions", "2026", "05", "29");
      fs.mkdirSync(sessionDir, { recursive: true });
      const filePath = path.join(sessionDir, "rollout-2026-05-29T12-00-00-huge.jsonl");
      fs.writeFileSync(
        filePath,
        [
          JSON.stringify({
            timestamp: "2026-05-29T12:00:00.000Z",
            type: "session_meta",
            payload: { id: "session-huge", originator: "codex_cli_rs", cwd: "/repo", model: "gpt-5.5" },
          }),
          JSON.stringify({
            timestamp: "2026-05-29T12:00:01.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
                last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          }),
          "",
        ].join("\n"),
      );
      // One byte past CODEX_COST_SCAN_MAX_FILE_BYTES (1 GiB). Sparse, so this
      // costs no disk.
      fs.truncateSync(filePath, 1024 * 1024 * 1024 + 1);

      await expect(scanCodexLogs()).resolves.toEqual([]);
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanOpenClawLogs", () => {
  it("parses assistant usage from OpenClaw session logs", async () => {
    const tmpDir = makeTmpDir();
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    try {
      const sessionDir = path.join(tmpDir, ".openclaw", "agents", "director", "sessions");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "session-1.jsonl"),
        [
          JSON.stringify({
            type: "session",
            id: "session-1",
            timestamp,
          }),
          JSON.stringify({
            type: "model_change",
            modelId: "gpt-5.4",
            timestamp,
          }),
          JSON.stringify({
            type: "message",
            id: "message-1",
            timestamp,
            message: {
              role: "assistant",
              model: "gpt-5.4",
              usage: {
                input: 100,
                output: 20,
                cacheRead: 30,
                cacheWrite: 40,
                cost: { total: 0.12 },
              },
            },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanOpenClawLogs([path.join(tmpDir, ".openclaw", "agents")]);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        model: "gpt-5.4",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 30,
        billableCachedTokens: 30,
        cacheWriteTokens: 40,
        costOverrideUsd: 0.12,
      });
      expect(aggregateCosts(entries, "openclaw").last30dCostUsd).toBe(0.12);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanDroidLogs", () => {
  it("distributes Droid settings token totals across assistant calls", async () => {
    const tmpDir = makeTmpDir();
    try {
      const sessionDir = path.join(tmpDir, "sessions", "project-a");
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionPath = path.join(sessionDir, "session-1.jsonl");
      fs.writeFileSync(
        sessionPath,
        [
          JSON.stringify({ type: "session_start", id: "session-1", cwd: "/repo" }),
          JSON.stringify({
            type: "message",
            id: "assistant-1",
            timestamp: "2026-05-29T12:00:00.000Z",
            message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          }),
          JSON.stringify({
            type: "message",
            id: "assistant-2",
            timestamp: "2026-05-29T12:01:00.000Z",
            message: { role: "assistant", content: [{ type: "tool_use", name: "Execute" }] },
          }),
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        sessionPath.replace(/\.jsonl$/, ".settings.json"),
        JSON.stringify({
          model: "custom:[anthropic]-claude-sonnet-5-20260501",
          tokenUsage: {
            inputTokens: 101,
            outputTokens: 41,
            thinkingTokens: 2,
            cacheCreationTokens: 5,
            cacheReadTokens: 9,
          },
        }),
      );

      const entries = await scanDroidLogs(path.join(tmpDir, "sessions"));

      expect(entries).toHaveLength(2);
      // Thinking tokens are billed at the output rate but are not output: they
      // show up only in `billableOutputTokens`, so the displayed output count
      // stays reasoning-free.
      expect(entries[0]).toMatchObject({
        model: "claude-sonnet-5",
        inputTokens: 50,
        outputTokens: 20,
        billableOutputTokens: 21,
        cachedTokens: 4,
        billableCachedTokens: 4,
        cacheWriteTokens: 2,
      });
      expect(entries[1]).toMatchObject({
        inputTokens: 51,
        outputTokens: 21,
        billableOutputTokens: 22,
        cachedTokens: 5,
        billableCachedTokens: 5,
        cacheWriteTokens: 3,
      });
      expect(aggregateCosts(entries, "droid").tokenBreakdownByPreset?.all?.["claude-sonnet-5"]?.costUsd).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanCopilotLogs", () => {
  it("parses Copilot legacy session state events", async () => {
    const tmpDir = makeTmpDir();
    try {
      const sessionDir = path.join(tmpDir, "session-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "events.jsonl"),
        [
          JSON.stringify({
            type: "session.model_change",
            timestamp: "2026-05-29T12:00:00.000Z",
            data: { newModel: "gpt-5.4" },
          }),
          JSON.stringify({
            type: "user.message",
            timestamp: "2026-05-29T12:00:01.000Z",
            data: { content: "please edit file" },
          }),
          JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-05-29T12:00:02.000Z",
            data: { messageId: "assistant-1", outputTokens: 42 },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanCopilotLogs(tmpDir, []);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        messageId: "copilot:session-1:assistant-1",
        model: "gpt-5.4",
        inputTokens: 4,
        outputTokens: 42,
        cachedTokens: 0,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("matches Copilot transcript token accounting when output tokens are recorded", async () => {
    const tmpDir = makeTmpDir();
    try {
      const transcriptsDir = path.join(tmpDir, "workspace-a", "GitHub.copilot-chat", "transcripts");
      fs.mkdirSync(transcriptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(transcriptsDir, "session-1.jsonl"),
        [
          JSON.stringify({
            type: "session.start",
            timestamp: "2026-05-29T12:00:00.000Z",
            data: { sessionId: "session-1", producer: "copilot-agent" },
          }),
          JSON.stringify({
            type: "tool.execution_complete",
            timestamp: "2026-05-29T12:00:01.000Z",
            data: { model: "gpt-5.4" },
          }),
          JSON.stringify({
            type: "user.message",
            timestamp: "2026-05-29T12:00:02.000Z",
            data: { content: "hello" },
          }),
          JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-05-29T12:00:03.000Z",
            data: {
              messageId: "assistant-1",
              content: "done",
              reasoningText: "hidden reasoning text that should not be added when outputTokens exists",
              outputTokens: 12,
            },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanCopilotLogs(path.join(tmpDir, "missing-session-state"), [tmpDir]);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        model: "gpt-5.4",
        inputTokens: 2,
        outputTokens: 12,
        billableOutputTokens: 12,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanGeminiLogs", () => {
  it("parses Gemini JSONL session token rows", async () => {
    const tmpDir = makeTmpDir();
    try {
      const chatsDir = path.join(tmpDir, "project-a", "chats");
      fs.mkdirSync(chatsDir, { recursive: true });
      fs.writeFileSync(
        path.join(chatsDir, "session-1.jsonl"),
        [
          JSON.stringify({
            sessionId: "session-1",
            startTime: "2026-05-29T12:00:00.000Z",
            projectHash: "project-a",
          }),
          JSON.stringify({
            id: "user-1",
            type: "user",
            timestamp: "2026-05-29T12:00:01.000Z",
            content: "build thing",
          }),
          JSON.stringify({
            id: "gemini-1",
            type: "gemini",
            timestamp: "2026-05-29T12:00:02.000Z",
            model: "gemini-3.1-pro-preview",
            content: "done",
            tokens: { input: 120, output: 30, cached: 20, thoughts: 5 },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanGeminiLogs(tmpDir);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        messageId: "gemini:session-1:gemini-1",
        model: "gemini-3.1-pro-preview",
        inputTokens: 100,
        // Gemini "thoughts" (5) bill at the output rate but are not output.
        outputTokens: 30,
        billableOutputTokens: 35,
        cachedTokens: 20,
        billableCachedTokens: 20,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanOpenCodeLogs", () => {
  it("parses assistant token rows from OpenCode SQLite databases", async () => {
    const tmpDir = makeTmpDir();
    const timestamp = Date.now() - 60_000;
    const { DatabaseSync } = requireForTest("node:sqlite") as { DatabaseSync: new (dbPath: string, options?: Record<string, unknown>) => any };
    try {
      const dbPath = path.join(tmpDir, "opencode.db");
      const db = new DatabaseSync(dbPath);
      db.exec(`
        create table message (
          id text,
          session_id text,
          time_created integer,
          data text
        );
      `);
      db.prepare("insert into message values (?, ?, ?, ?)").run(
        "msg-1",
        "session-1",
        timestamp,
        JSON.stringify({
          role: "assistant",
          modelID: "openai/gpt-5.4",
          cost: 0.42,
          tokens: {
            input: 100,
            output: 20,
            reasoning: 3,
            cache: { read: 40, write: 5 },
          },
        }),
      );
      db.close();

      const entries = await scanOpenCodeLogs(tmpDir);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        messageId: "opencode:session-1:msg-1",
        model: "openai/gpt-5.4",
        inputTokens: 100,
        // Reasoning (3) is billed as output but is not output: it belongs in
        // `billableOutputTokens` only, never in the displayed output count.
        outputTokens: 20,
        billableOutputTokens: 23,
        cachedTokens: 40,
        billableCachedTokens: 40,
        cacheWriteTokens: 5,
        costOverrideUsd: 0.42,
      });
      expect(aggregateCosts(entries, "opencode").last30dCostUsd).toBe(0.42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanCursorLogs", () => {
  it("parses Cursor bubble token rows from state.vscdb", async () => {
    const tmpDir = makeTmpDir();
    const { DatabaseSync } = requireForTest("node:sqlite") as { DatabaseSync: new (dbPath: string, options?: Record<string, unknown>) => any };
    try {
      const dbPath = path.join(tmpDir, "state.vscdb");
      const db = new DatabaseSync(dbPath);
      db.exec("create table cursorDiskKV (key text, value text);");
      db.prepare("insert into cursorDiskKV values (?, ?)").run(
        "bubbleId:conversation-1:bubble-1",
        JSON.stringify({
          tokenCount: { inputTokens: 120, outputTokens: 30 },
          modelInfo: { modelName: "cursor-auto" },
          createdAt: "2026-05-29T12:00:00.000Z",
          conversationId: "conversation-1",
          text: "hello",
          type: 1,
        }),
      );
      db.close();

      const entries = await scanCursorLogs(dbPath);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        messageId: "cursor:bubble:bubbleId:conversation-1:bubble-1",
        model: "cursor-auto",
        inputTokens: 120,
        outputTokens: 30,
        cachedTokens: 0,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanCursorAgentLogs", () => {
  it("estimates Cursor Agent transcript turns from local transcript files", async () => {
    const tmpDir = makeTmpDir();
    try {
      const transcriptDir = path.join(tmpDir, "project-a", "agent-transcripts", "00000000-0000-4000-8000-000000000001");
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.writeFileSync(
        path.join(transcriptDir, "00000000-0000-4000-8000-000000000001.jsonl"),
        [
          JSON.stringify({
            role: "user",
            message: { content: [{ type: "text", text: "<user_query>write code</user_query>" }] },
          }),
          JSON.stringify({
            role: "assistant",
            message: { content: [{ type: "text", text: "here is code" }] },
          }),
          "",
        ].join("\n"),
      );

      const entries = await scanCursorAgentLogs(tmpDir);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        model: "cursor-agent-auto",
        inputTokens: 3,
        outputTokens: 3,
        cachedTokens: 0,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("findJsonlFiles", () => {
  it("finds .jsonl files in nested directories", async () => {
    const tmpDir = makeTmpDir();
    const subDir = path.join(tmpDir, "sub", "deep");
    fs.mkdirSync(subDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, "root.jsonl"), '{"test": true}\n');
    fs.writeFileSync(path.join(subDir, "nested.jsonl"), '{"test": true}\n');
    fs.writeFileSync(path.join(tmpDir, "not-jsonl.txt"), "hello");

    const files = await _testing.findJsonlFiles(tmpDir, 1);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("root.jsonl"))).toBe(true);
    expect(files.some((f) => f.endsWith("nested.jsonl"))).toBe(true);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes files older than maxAgeDays", async () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, "old.jsonl");
    fs.writeFileSync(filePath, '{"test": true}\n');

    // Set mtime to 60 days ago
    const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, oldTime, oldTime);

    const files = await _testing.findJsonlFiles(tmpDir, 30);
    expect(files).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips oversized jsonl files before scanning costs", async () => {
    const tmpDir = makeTmpDir();
    const smallPath = path.join(tmpDir, "small.jsonl");
    const bigPath = path.join(tmpDir, "large.jsonl");
    fs.writeFileSync(smallPath, '{"test": true}\n');
    fs.writeFileSync(bigPath, "");
    fs.truncateSync(bigPath, 769 * 1024 * 1024);

    const files = await _testing.findJsonlFiles(tmpDir, 30);

    expect(files).toEqual([smallPath]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Two machines reading one shared (NFS/SMB) transcript directory get no
  // guarantee of matching readdir order. Since the scan caps the file count,
  // mtime ties decided by readdir order would hand each machine a different
  // retained set, a different token total, and a false "diverged" verdict from
  // the account-usage dedupe — which double-counts every shared token.
  it("retains the same tied files regardless of directory read order", () => {
    const tied = ["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"].map((name) => ({
      path: `/share/claude/${name}`,
      mtimeMs: 1_700_000_000_000,
    }));
    const newer = { path: "/share/claude/z.jsonl", mtimeMs: 1_700_000_001_000 };

    const retain = (candidates: typeof tied) =>
      [...candidates].sort(compareRecentFileCandidates).slice(0, 3).map((file) => file.path);

    const machineA = retain([newer, ...tied]);
    const machineB = retain([tied[2]!, tied[0]!, newer, tied[3]!, tied[1]!]);
    const machineC = retain([...tied].reverse().concat(newer));

    expect(machineA).toEqual(["/share/claude/z.jsonl", "/share/claude/a.jsonl", "/share/claude/b.jsonl"]);
    expect(machineB).toEqual(machineA);
    expect(machineC).toEqual(machineA);
  });

  it("caps tied-mtime files deterministically on disk", async () => {
    const tmpDir = makeTmpDir();
    const stamp = new Date(Date.now() - 60_000);
    const names = ["d.jsonl", "b.jsonl", "e.jsonl", "a.jsonl", "c.jsonl"];
    for (const name of names) {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, '{"test": true}\n');
      fs.utimesSync(filePath, stamp, stamp);
    }

    const files = await _testing.findJsonlFiles(tmpDir, 1, { maxFiles: 3 });

    expect(files).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"].map((name) => path.join(tmpDir, name)));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("buildProviderWindows", () => {
  const win = (percentUsed: number) => ({
    provider: "claude" as const,
    windowType: "weekly" as const,
    percentUsed,
    resetsAt: "2026-01-01T00:00:00Z",
    resetsInMs: 1,
  });

  it("marks ok and stamps lastSuccessAt when fresh windows arrive", () => {
    const fresh = [win(10)];
    const result = buildProviderWindows(
      "claude",
      fresh,
      [],
      [],
      null,
      "2026-06-07T00:00:00Z",
      "oauth",
    );
    expect(result.status.state).toBe("ok");
    expect(result.status.lastSuccessAt).toBe("2026-06-07T00:00:00Z");
    expect(result.status.updatedAt).toBe("2026-06-07T00:00:00Z");
    expect(result.status.lastAttemptAt).toBe("2026-06-07T00:00:00Z");
    expect(result.status.source).toBe("oauth");
    expect(result.lastSuccessAt).toBe("2026-06-07T00:00:00Z");
    expect(result.windows).toBe(fresh);
  });

  it("carries forward previous windows as stale on an empty/failed poll", () => {
    const prev = [{ ...win(42), resetsAt: "2026-06-08T00:00:00Z" }];
    const result = buildProviderWindows(
      "claude",
      [],
      ["claude: API returned 409"],
      prev,
      "2026-06-06T00:00:00Z",
      "2026-06-07T00:00:00Z",
    );
    expect(result.status.state).toBe("stale");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.percentUsed).toBe(42);
    // lastSuccessAt is preserved from the previous success, not the failed poll.
    expect(result.status.lastSuccessAt).toBe("2026-06-06T00:00:00Z");
    expect(result.status.message).toContain("Claude");
  });

  it("drops carried windows that have passed their reset boundary", () => {
    const result = buildProviderWindows(
      "claude",
      [],
      ["claude: API returned 409"],
      [
        { ...win(99), resetsAt: "2026-06-06T23:59:00Z", resetsInMs: 0 },
        { ...win(12), resetsAt: "2026-06-07T00:30:00Z", resetsInMs: 30 * 60 * 1000 },
      ],
      "2026-06-06T00:00:00Z",
      "2026-06-07T00:00:00Z",
    );

    expect(result.status.state).toBe("stale");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.percentUsed).toBe(12);
    expect(result.windows[0]?.resetsInMs).toBe(30 * 60 * 1000);
  });

  it("reports an error instead of carrying only expired windows", () => {
    const result = buildProviderWindows(
      "codex",
      [],
      ["codex: API returned 500"],
      [{ ...win(88), provider: "codex" as const, resetsAt: "2026-06-06T23:59:00Z", resetsInMs: 0 }],
      "2026-06-06T00:00:00Z",
      "2026-06-07T00:00:00Z",
    );

    expect(result.status.state).toBe("error");
    expect(result.status.message).toMatch(/expired/i);
    expect(result.windows).toEqual([]);
  });

  it("reports unauthed when there is no fallback and credentials are missing", () => {
    const result = buildProviderWindows("codex", [], ["codex: no credentials found"], [], null, "t");
    expect(result.status.state).toBe("unauthed");
    expect(result.windows).toEqual([]);
  });

  it("clears previous windows when credentials disappear", () => {
    const prev = [win(42)];
    const result = buildProviderWindows(
      "codex",
      [],
      ["codex: no credentials found"],
      prev,
      "2026-06-06T00:00:00Z",
      "2026-06-07T00:00:00Z",
    );
    expect(result.status.state).toBe("unauthed");
    expect(result.status.lastSuccessAt).toBe("2026-06-06T00:00:00Z");
    expect(result.windows).toEqual([]);
  });

  it("reports error (not unauthed) when there is no fallback and the call failed", () => {
    const result = buildProviderWindows("codex", [], ["codex: API returned 500"], [], null, "t");
    expect(result.status.state).toBe("error");
    expect(result.status.message).toMatch(/couldn't reach/i);
  });

  it("frames a 401/expired-token failure as reconnect, not unreachable", () => {
    const result = buildProviderWindows("claude", [], ["claude: API returned 401"], [], null, "t");
    expect(result.status.state).toBe("unauthed");
    expect(result.status.message).toMatch(/sign-in expired|reconnect/i);
  });

  it("preserves a forbidden error kind while showing reconnect guidance", () => {
    const result = buildProviderWindows(
      "claude",
      [],
      ["claude: API returned 403"],
      [],
      null,
      "t",
      "oauth",
      "forbidden",
    );
    expect(result.status.state).toBe("unauthed");
    expect(result.status.errorKind).toBe("forbidden");
  });
});

describe("usage reliability: non-destructive merge", () => {
  const futureIso = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("keeps the last-good windows when a provider poll fails (no flicker)", async () => {
    const logger = createLogger();
    const weeklyMs = 3 * 24 * 60 * 60 * 1000;
    const claudeWindow = {
      provider: "claude" as const,
      windowType: "weekly" as const,
      percentUsed: 40,
      resetsAt: futureIso(weeklyMs),
      resetsInMs: weeklyMs,
    };
    const claudeExtraUsage = {
      provider: "claude" as const,
      isEnabled: true,
      usedCreditsUsd: 12,
      monthlyLimitUsd: 100,
      utilization: 12,
      currency: "usd",
    };
    const pollClaudeUsage = vi
      .fn()
      .mockResolvedValueOnce({ windows: [claudeWindow], extraUsage: claudeExtraUsage, errors: [] })
      .mockResolvedValueOnce({ windows: [], extraUsage: null, errors: ["claude: API returned 409"] });
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        pollClaudeUsage,
        pollCodexUsage: vi.fn(async () => ({ windows: [], errors: [] })),
      },
    });

    const first = await service.poll();
    expect(first.windows.filter((w) => w.provider === "claude")).toHaveLength(1);
    expect(first.extraUsage).toEqual([claudeExtraUsage]);
    expect(first.providerStatus?.claude?.state).toBe("ok");

    const second = await service.poll();
    const claudeWindows = second.windows.filter((w) => w.provider === "claude");
    expect(claudeWindows).toHaveLength(1);
    expect(claudeWindows[0]?.percentUsed).toBe(40);
    expect(second.extraUsage).toEqual([claudeExtraUsage]);
    expect(second.providerStatus?.claude?.state).toBe("stale");
    expect(second.providerStatus?.claude?.lastSuccessAt).toBe(first.lastPolledAt);

    service.dispose();
  });

  it("keeps a valid Claude status when a mobile refresh cannot read interactive credentials", async () => {
    const logger = createLogger();
    const weeklyMs = 3 * 24 * 60 * 60 * 1000;
    const claudeWindow = {
      provider: "claude" as const,
      windowType: "weekly" as const,
      percentUsed: 37,
      resetsAt: futureIso(weeklyMs),
      resetsInMs: weeklyMs,
    };
    const claudeExtraUsage = {
      provider: "claude" as const,
      isEnabled: true,
      usedCreditsUsd: 9,
      monthlyLimitUsd: 100,
      utilization: 9,
      currency: "usd",
    };
    const pollClaudeUsage = vi
      .fn()
      .mockResolvedValueOnce({
        windows: [claudeWindow],
        errors: [],
        source: "oauth" as const,
        extraUsage: claudeExtraUsage,
      })
      .mockResolvedValueOnce({
        disposition: "preserve_previous" as const,
        windows: [],
        errors: [],
        source: "oauth" as const,
      });
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        pollClaudeUsage,
        pollCodexUsage: vi.fn(async () => ({ windows: [], errors: [] })),
      },
    });

    const first = await service.poll({ reason: "user" });
    const refreshed = await service.poll({ reason: "remote" });

    expect(first.providerStatus?.claude?.state).toBe("ok");
    expect(refreshed.providerStatus?.claude).toEqual(first.providerStatus?.claude);
    expect(refreshed.windows.filter((window) => window.provider === "claude")).toHaveLength(1);
    const preservedWindow = refreshed.windows.find((window) => window.provider === "claude");
    expect(preservedWindow).toMatchObject({
      ...claudeWindow,
      resetsInMs: expect.any(Number),
    });
    expect(preservedWindow?.resetsInMs).toBeGreaterThan(weeklyMs - 1_000);
    expect(preservedWindow?.resetsInMs).toBeLessThanOrEqual(weeklyMs);
    expect(refreshed.extraUsage).toEqual([claudeExtraUsage]);
    expect(refreshed.errors).toEqual([]);

    service.dispose();
  });

  it("downgrades a preserved provider after its final carried window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const pollClaudeUsage = vi
      .fn()
      .mockResolvedValueOnce({
        windows: [{
          provider: "claude" as const,
          windowType: "weekly" as const,
          percentUsed: 37,
          resetsAt: "2026-07-17T12:01:00.000Z",
          resetsInMs: 60_000,
        }],
        errors: [],
        source: "oauth" as const,
      })
      .mockResolvedValueOnce({
        disposition: "preserve_previous" as const,
        windows: [],
        errors: [],
        source: "oauth" as const,
      });
    const service = createUsageTrackingService({
      logger: createLogger(),
      dependencies: {
        pollClaudeUsage,
        pollCodexUsage: vi.fn(async () => ({ windows: [], errors: [] })),
      },
    });

    try {
      const first = await service.poll({ reason: "user" });
      expect(first.providerStatus?.claude?.state).toBe("ok");

      vi.advanceTimersByTime(60_000);
      const expired = await service.poll({ reason: "remote" });

      expect(expired.windows.filter((window) => window.provider === "claude")).toEqual([]);
      expect(expired.providerStatus?.claude).toMatchObject({
        state: "stale",
        lastSuccessAt: first.lastPolledAt,
      });
      expect(expired.providerStatus?.claude?.message).toMatch(/expired/i);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("clears a sticky Claude auth error when a remote refresh cannot verify credentials", async () => {
    const logger = createLogger();
    const weeklyMs = 3 * 24 * 60 * 60 * 1000;
    const claudeWindow = {
      provider: "claude" as const,
      windowType: "weekly" as const,
      percentUsed: 37,
      resetsAt: futureIso(weeklyMs),
      resetsInMs: weeklyMs,
    };
    const pollClaudeUsage = vi
      .fn()
      .mockResolvedValueOnce({ windows: [claudeWindow], errors: [], source: "oauth" as const })
      .mockResolvedValueOnce({
        windows: [],
        errors: ["claude: no non-interactive credentials found"],
        errorKind: "auth" as const,
        source: "oauth" as const,
      })
      .mockResolvedValueOnce({
        disposition: "preserve_previous" as const,
        windows: [],
        errors: [],
        source: "oauth" as const,
      });
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        pollClaudeUsage,
        pollCodexUsage: vi.fn(async () => ({ windows: [], errors: [] })),
      },
    });

    await service.poll({ reason: "user" });
    const staleError = await service.poll({ reason: "remote" });
    const refreshed = await service.poll({ reason: "remote" });

    expect(staleError.providerStatus?.claude?.state).toBe("unauthed");
    expect(refreshed.providerStatus?.claude).toMatchObject({
      state: "stale",
      lastSuccessAt: expect.any(String),
    });
    expect(refreshed.providerStatus?.claude?.message).toBeUndefined();
    expect(refreshed.windows.filter((window) => window.provider === "claude")).toHaveLength(1);
    expect(refreshed.errors).toEqual([]);

    service.dispose();
  });

  it("preserves a genuine Claude auth error while automatic polling is backed off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const logger = createLogger();
    const pollClaudeUsage = vi
      .fn()
      .mockResolvedValueOnce({
        windows: [],
        errors: ["claude: API returned 401"],
        errorKind: "auth" as const,
        source: "oauth" as const,
      })
      .mockResolvedValueOnce({
        disposition: "preserve_previous" as const,
        windows: [],
        errors: [],
        source: "oauth" as const,
      });
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        pollClaudeUsage,
        pollCodexUsage: vi.fn(async () => ({ windows: [], errors: [] })),
      },
    });

    const failed = await service.poll({ reason: "user" });
    const backedOff = await service.poll({ reason: "automatic" });
    vi.advanceTimersByTime(61_000);
    const nonInteractive = await service.poll({ reason: "automatic" });

    expect(failed.providerStatus?.claude?.state).toBe("unauthed");
    expect(backedOff.providerStatus?.claude).toEqual(failed.providerStatus?.claude);
    expect(nonInteractive.providerStatus?.claude).toEqual(failed.providerStatus?.claude);
    expect(pollClaudeUsage).toHaveBeenCalledTimes(2);

    service.dispose();
    vi.useRealTimers();
  });

  it("attaches per-window pacing for both the 5-hour and weekly windows", async () => {
    const logger = createLogger();
    const fiveHourMs = 2 * 60 * 60 * 1000; // 60% of the 5h window elapsed
    const weeklyMs = 3 * 24 * 60 * 60 * 1000;
    const service = createUsageTrackingService({
      logger,
      dependencies: {
        pollClaudeUsage: vi.fn(async () => ({
          windows: [
            { provider: "claude" as const, windowType: "five_hour" as const, percentUsed: 80, resetsAt: futureIso(fiveHourMs), resetsInMs: fiveHourMs },
            { provider: "claude" as const, windowType: "weekly" as const, percentUsed: 8, resetsAt: futureIso(weeklyMs), resetsInMs: weeklyMs },
          ],
          extraUsage: null,
          errors: [],
        })),
        pollCodexUsage: vi.fn(async () => ({ windows: [], errors: [] })),
      },
    });

    const snap = await service.poll();
    const five = snap.windows.find((w) => w.windowType === "five_hour");
    const weekly = snap.windows.find((w) => w.windowType === "weekly");
    expect(five?.pacing).toBeDefined();
    expect(weekly?.pacing).toBeDefined();
    // 80% used with only ~60% of the 5h window elapsed → burning ahead of pace.
    expect(five?.pacing?.deltaPercent ?? 0).toBeGreaterThan(0);

    service.dispose();
  });
});

describe("fetchJsonWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a transient 5xx and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ five_hour: { percent_used: 5 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchJsonWithRetry("https://example.test/usage", {}, { attempts: 2, backoffMs: 0 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network/timeout abort and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("The operation was aborted"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchJsonWithRetry("https://example.test/usage", {}, { attempts: 2, backoffMs: 0 });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 429 — backs off instead of amplifying the throttle", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchJsonWithRetry("https://example.test/usage", {}, { attempts: 2, backoffMs: 0 });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves Retry-After metadata for provider backoff", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? "120" : null },
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchJsonWithRetry("https://example.test/usage", {}, { attempts: 2, backoffMs: 0 });
    expect(res.retryAfterMs).toBe(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429 with an empty or non-JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchJsonWithRetry("https://example.test/usage", {}, { attempts: 2, backoffMs: 0 });
    expect(res).toEqual({ ok: false, status: 429, data: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 409 conflict", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchJsonWithRetry("https://example.test/usage", {}, { attempts: 2, backoffMs: 0 });
    expect(res.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-transient 401 (defers to the refresh path)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchJsonWithRetry("https://example.test/usage", {}, { attempts: 2, backoffMs: 0 });
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ADE database usage aggregation", () => {
  const roots: string[] = [];
  const databases: AdeDb[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function createStatsDb(): Promise<AdeDb> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-usage-stats-"));
    roots.push(root);
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());
    databases.push(db);
    db.run(
      `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["project-1", root, "ADE", "main", "2026-07-01T00:00:00.000Z", "2026-07-09T00:00:00.000Z"],
    );
    db.run(
      `insert into lanes(
         id, project_id, name, lane_type, base_ref, branch_ref, worktree_path,
         is_edit_protected, status, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-1", "project-1", "Stats", "worktree", "main", "ade-109", root, 0, "active", "2026-07-08T10:00:00.000Z"],
    );
    return db;
  }

  const createDatabaseServiceDependencies = () => ({
    pollClaudeUsage: vi.fn(async () => ({ windows: [] as never[], extraUsage: null, errors: [] as never[] })),
    pollCodexUsage: vi.fn(async () => ({ windows: [] as never[], errors: [] as never[] })),
    scanClaudeLogs: vi.fn(async () => [] as never[]),
    scanCodexLogs: vi.fn(async () => [] as never[]),
    scanCursorLogs: vi.fn(async () => [] as never[]),
    scanCursorAgentLogs: vi.fn(async () => [] as never[]),
    scanOpenClawLogs: vi.fn(async () => [] as never[]),
    scanOpenCodeLogs: vi.fn(async () => [] as never[]),
    scanDroidLogs: vi.fn(async () => [] as never[]),
    scanCopilotLogs: vi.fn(async () => [] as never[]),
    scanGeminiLogs: vi.fn(async () => [] as never[]),
    scanGitHubStats: vi.fn(async () => ({
      repo: null,
      available: false,
      fetchedAt: null,
      error: null,
      commitsCreated: 0,
      prsTracked: 0,
      prsOpen: 0,
      prsMerged: 0,
      prsClosed: 0,
      prAdditions: 0,
      prDeletions: 0,
      filesChanged: 0,
      daily: [],
    })),
  });

  it("prod context wires db aggregates into the usage service", async () => {
    const db = await createStatsDb();
    db.run(
      `insert into operations(id, project_id, lane_id, kind, started_at, ended_at, status)
       values (?, ?, ?, ?, ?, ?, ?)`,
      ["op-prod", "project-1", "lane-1", "git_commit", "2026-07-08T12:00:00.000Z", "2026-07-08T12:00:01.000Z", "succeeded"],
    );
    const service = createUsageTrackingService({
      logger: createLogger(),
      db,
      projectRoot: "/repo",
      dependencies: createDatabaseServiceDependencies(),
    });

    const stats = await service.getAdeUsageStats({
      preset: "all",
      until: "2026-07-09T00:00:00.000Z",
    });

    expect(stats.localActivity?.commits).toBe(1);
    expect(stats.summary.commitsCreated).toBe(1);
    expect(stats.daily.find((point) => point.date === "2026-07-08")?.commits).toBe(1);
    service.dispose();
  });

  /**
   * Deleting a lane cascades away its `lanes`, session, delta and `operations`
   * rows, so every one of these counts used to fall when a user tidied up —
   * "lifetime" figures that were really survivor figures. The tombstone is the
   * only surviving record, and until this it was written and never read.
   */
  function insertTombstone(db: AdeDb, overrides: Record<string, unknown> = {}): void {
    const row = {
      project_id: "project-1",
      lane_id: "lane-gone",
      created_day: "2026-07-06",
      deleted_day: "2026-07-08",
      lanes_created: 1,
      chat_sessions: 3,
      terminal_sessions: 2,
      files_changed: 11,
      insertions: 120,
      deletions: 30,
      commits_created: 4,
      push_operations: 2,
      pr_landings: 1,
      artifacts_captured: 5,
      longest_session_ms: 900_000,
      first_active_day: "2026-07-06",
      last_active_day: "2026-07-07",
      ...overrides,
    };
    const columns = Object.keys(row);
    db.run(
      `insert into lane_usage_tombstones(${columns.join(", ")}, active_day_bits)
       values (${columns.map(() => "?").join(", ")}, ?)`,
      [
        ...columns.map((column) => (row as Record<string, string | number>)[column]!),
        encodeActiveDayBits([
          String(row.first_active_day),
          String(row.last_active_day),
        ]).bits,
      ],
    );
  }

  it("does not count an absorbed duplicate as a deletion", async () => {
    // The create/recover race folds a duplicate lane row onto its keeper and
    // writes a tombstone with `lanes_created: 0` — it was never a lane the user
    // made, and it was never one they deleted either. Counting it on only one
    // side read as "1 created / 2 deleted" for a single real lane.
    const db = await createStatsDb();
    insertTombstone(db);
    insertTombstone(db, {
      lane_id: "lane-absorbed",
      lanes_created: 0,
      chat_sessions: 0,
      terminal_sessions: 0,
      files_changed: 0,
      insertions: 0,
      deletions: 0,
      commits_created: 0,
      push_operations: 0,
      pr_landings: 0,
      artifacts_captured: 0,
      longest_session_ms: 0,
    });

    const stats = collectAdeDatabaseUsageStats(db, { since: null, until: "2026-07-09T23:59:59.999Z" });

    // The real delete still counts; the absorb is invisible on both sides.
    expect(stats?.summary.lanesDeleted).toBe(1);
    expect(stats?.summary.lanesCreated).toBe(2);
  });

  it("counts a deleted lane's activity from its tombstone", async () => {
    const db = await createStatsDb();
    insertTombstone(db);

    const stats = collectAdeDatabaseUsageStats(db, { since: null, until: "2026-07-09T23:59:59.999Z" });

    expect(stats?.summary.chatSessions).toBe(3);
    expect(stats?.summary.terminalSessions).toBe(2);
    expect(stats?.summary.filesChanged).toBe(11);
    expect(stats?.summary.insertions).toBe(120);
    expect(stats?.summary.deletions).toBe(30);
    expect(stats?.summary.commitsCreated).toBe(4);
    expect(stats?.summary.pushOperations).toBe(2);
    expect(stats?.summary.prLandings).toBe(1);
    expect(stats?.summary.artifactsCaptured).toBe(5);
    expect(stats?.summary.longestSessionMs).toBe(900_000);
    // One surviving lane in the fixture, plus the deleted one.
    expect(stats?.summary.lanesCreated).toBe(2);
    // The `operations` row that recorded this delete is long pruned; the
    // tombstone is exact and permanent.
    expect(stats?.summary.lanesDeleted).toBe(1);
    // Both of the tombstone's active days count, and they are consecutive.
    expect(stats?.summary.activeDays).toBe(2);
    expect(stats?.summary.longestStreakDays).toBe(2);
    // Not folded into the per-day chart or the lane breakdown: the tombstone
    // has no per-day counts and no lane name, and a bare UUID row would be
    // worse than none.
    expect(stats?.lanes?.some((lane) => lane.laneId === "lane-gone")).toBe(false);
  });

  it("counts a fresh delete once when the operations row and the tombstone both survive", async () => {
    const db = await createStatsDb();
    insertTombstone(db);
    // `lane_delete` operations rows are written with a null `lane_id`, so the
    // lane cleanup's `delete from operations where lane_id = ?` leaves them
    // behind — for 60 days both this row and the tombstone describe the very
    // same delete. Summing them reported 2 in the Activity breakdown while the
    // summary, which reconciles, still said 1.
    db.run(
      `insert into operations(id, project_id, lane_id, kind, started_at, ended_at, status)
       values (?, ?, ?, ?, ?, ?, ?)`,
      ["op-delete", "project-1", null, "lane_delete", "2026-07-08T12:00:00.000Z", "2026-07-08T12:00:01.000Z", "succeeded"],
    );

    const stats = collectAdeDatabaseUsageStats(db, { since: null, until: "2026-07-09T23:59:59.999Z" });

    expect(stats?.summary.lanesDeleted).toBe(1);
    expect(stats?.activities?.find((activity) => activity.kind === "lanes.delete")?.count).toBe(1);
  });

  it("attributes a tombstone to a window only when the window contains the lane's whole life", async () => {
    const db = await createStatsDb();
    // Lived 06–07, deleted on the 08th.
    insertTombstone(db);

    // Window ends before the lane stopped being active: its totals are not
    // attributable to this window, because they have no per-day breakdown.
    const before = collectAdeDatabaseUsageStats(db, {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-06T23:59:59.999Z",
    });
    expect(before?.summary.insertions).toBe(0);
    expect(before?.summary.chatSessions).toBe(0);
    // A day is atomic, so the day inside the window still counts as active.
    expect(before?.summary.activeDays).toBe(1);

    // Window that contains the whole life, right at the boundary.
    const spanning = collectAdeDatabaseUsageStats(db, {
      since: "2026-07-06T00:00:00.000Z",
      until: "2026-07-07T23:59:59.999Z",
    });
    expect(spanning?.summary.insertions).toBe(120);
    // …but the delete happened after this window, so it is not counted here.
    expect(spanning?.summary.lanesDeleted).toBe(0);

    const includingDelete = collectAdeDatabaseUsageStats(db, {
      since: "2026-07-08T00:00:00.000Z",
      until: "2026-07-08T23:59:59.999Z",
    });
    expect(includingDelete?.summary.lanesDeleted).toBe(1);
  });

  it("without db yields null database stats and zero local aggregates", async () => {
    const range = { since: "2026-07-08T00:00:00.000Z", until: "2026-07-09T00:00:00.000Z" };
    expect(collectAdeDatabaseUsageStats(undefined, range)).toBeNull();
    const service = createUsageTrackingService({
      logger: createLogger(),
      dependencies: createDatabaseServiceDependencies(),
    });

    const stats = await service.getAdeUsageStats({ preset: "all", ...range });

    expect(stats.localActivity).toMatchObject({
      commits: 0,
      pushOperations: 0,
      prLandings: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
    service.dispose();
  });

  it("buckets database timestamps by the local calendar day", async () => {
    const db = await createStatsDb();
    const localInstant = new Date(2026, 0, 15, 0, 30, 0, 0);
    const expectedDay = localDayKey(localInstant);
    db.run(
      `insert into ai_usage_log(id, timestamp, feature, provider, model, input_tokens, output_tokens, duration_ms, success)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["ai-local-day", localInstant.toISOString(), "chat", "claude", "opus", 4, 2, 10, 1],
    );

    const stats = collectAdeDatabaseUsageStats(db, {
      since: new Date(2026, 0, 15, 0, 0, 0, 0).toISOString(),
      until: new Date(2026, 0, 15, 23, 59, 59, 999).toISOString(),
    });

    expect(stats?.daily).toContainEqual(expect.objectContaining({
      date: expectedDay,
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    }));
  });

  it("caps daily source windows newest-first before aggregating in SQLite", async () => {
    const db = await createStatsDb();
    const logger = createLogger();
    const originalAll = db.all.bind(db);
    let checkedClientQuery = false;
    let checkedOperationQuery = false;
    let checkedAiQuery = false;
    const cappedDb: AdeDb = {
      ...db,
      all: ((sql: string, params = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.startsWith("select date(occurred_at, 'localtime') active_date")) {
          expect(normalized).toContain("from ( select occurred_at, client_surface");
          expect(normalized).toContain("order by occurred_at desc limit ? ) group by active_date, client_surface");
          checkedClientQuery = true;
          return [{
            active_date: "2026-07-08",
            client_surface: "desktop",
            interactions: 250_000,
          }];
        }
        if (normalized.startsWith("select date(started_at, 'localtime') active_date")) {
          expect(normalized).toContain("from ( select started_at, kind");
          expect(normalized).toContain("order by started_at desc limit ? ) group by active_date, kind");
          checkedOperationQuery = true;
          return [{
            active_date: "2026-07-08",
            kind: "git_commit",
            operations: 250_000,
          }];
        }
        if (normalized.startsWith("select date(timestamp, 'localtime') active_date")) {
          // Grouped by provider as well as day so the gap-filled tokens land in
          // a chart series instead of only in the day's total.
          expect(normalized).toContain("from ( select timestamp, provider, input_tokens, output_tokens, duration_ms");
          expect(normalized).toContain("order by timestamp desc limit ? ) group by active_date, provider");
          expect(params.at(-1)).toBe(250_000);
          checkedAiQuery = true;
          return [{
            active_date: "2026-07-08",
            provider: "claude",
            input_tokens: 250_000,
            output_tokens: 0,
            duration_ms: 0,
            calls: 250_000,
          }];
        }
        return originalAll(sql, params);
      }) as AdeDb["all"],
    };

    const stats = collectAdeDatabaseUsageStats(cappedDb, {
      since: null,
      until: "2026-07-09T00:00:00.000Z",
    }, logger);

    expect(checkedClientQuery).toBe(true);
    expect(checkedOperationQuery).toBe(true);
    expect(checkedAiQuery).toBe(true);
    expect(stats?.daily).toContainEqual(expect.objectContaining({
      date: "2026-07-08",
      inputTokens: 250_000,
      totalTokens: 250_000,
      commits: 250_000,
      interactions: 250_000,
      clients: { desktop: 250_000 },
      byProvider: { claude: { totalTokens: 250_000, costUsd: 0 } },
    }));
    expect(stats?.daily.some((point) => point.date === "2026-07-07")).toBe(false);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith("usage.daily_bucket_scan_capped", {
      maxRows: 250_000,
      sources: ["usage_events", "operations", "ai_usage_log"],
    });
  });

  it("keeps active-day and streak summaries exact when usage events exceed the daily chart cap", async () => {
    const db = await createStatsDb();
    const logger = createLogger();
    const firstDayAtNoon = new Date(2026, 6, 6, 12).toISOString();
    const secondDayAtNoon = new Date(2026, 6, 7, 12).toISOString();
    const thirdDayAtNoon = new Date(2026, 6, 8, 12).toISOString();
    const firstDay = localDayKey(firstDayAtNoon);
    const secondDay = localDayKey(secondDayAtNoon);
    const thirdDay = localDayKey(thirdDayAtNoon);

    db.run(`
      with recursive sequence(value) as (
        select 1
        union all
        select value + 1 from sequence where value < 250001
      )
      insert into usage_events(
        id, project_id, client_surface, action, feature, session_id, occurred_at
      )
      select 'bulk-' || value, 'project-1', 'desktop', 'chat.send', 'chat', 'bulk-session',
             case value when 1 then ? when 2 then ? else ? end
        from sequence
    `, [firstDayAtNoon, secondDayAtNoon, thirdDayAtNoon]);

    const stats = collectAdeDatabaseUsageStats(db, {
      since: new Date(2026, 6, 6, 0, 0, 0, 0).toISOString(),
      until: new Date(2026, 6, 8, 23, 59, 59, 999).toISOString(),
    }, logger);

    expect(stats?.summary).toMatchObject({
      totalInteractions: 250_001,
      activeDays: 3,
      currentStreakDays: 3,
      longestStreakDays: 3,
    });
    expect(stats?.clients).toContainEqual(expect.objectContaining({
      client: "desktop",
      interactions: 250_001,
      activeDays: 3,
      sessions: 1,
      lastActiveAt: thirdDayAtNoon,
    }));
    expect(stats?.daily).toContainEqual(expect.objectContaining({
      date: secondDay,
      interactions: 1,
    }));
    expect(stats?.daily).toContainEqual(expect.objectContaining({
      date: thirdDay,
      interactions: 249_999,
    }));
    expect(stats?.daily.some((point) => point.date === firstDay)).toBe(false);
    expect(stats?.daily.reduce((sum, point) => sum + (point.interactions ?? 0), 0)).toBe(250_000);
    expect(logger.debug).toHaveBeenCalledWith("usage.daily_bucket_scan_capped", {
      maxRows: 250_000,
      sources: ["usage_events"],
    });
  });

  it("combines successful ADE operations, sessions, tokens, and client activity without double-counting", async () => {
    const db = await createStatsDb();
    db.run(
      `insert into terminal_sessions(
         id, lane_id, tracked, tool_type, pinned, title, started_at, ended_at,
         transcript_path, status, chat_session_id, resume_metadata_json
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["session-1", "lane-1", 1, "claude-chat", 0, "Stats", "2026-07-08T12:00:00.000Z", "2026-07-08T12:30:00.000Z", "/tmp/stats.log", "exited", "session-1", JSON.stringify({ provider: "claude", launch: { model: "claude-sonnet-5" } })],
    );
    db.run(
      `insert into session_deltas(
         session_id, project_id, lane_id, started_at, ended_at, files_changed,
         insertions, deletions, touched_files_json, failure_lines_json, computed_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["session-1", "project-1", "lane-1", "2026-07-08T12:00:00.000Z", "2026-07-08T12:30:00.000Z", 3, 120, 20, "[]", "[]", "2026-07-08T12:31:00.000Z"],
    );
    // Rename/mode-only delta on a different day: files changed but zero line churn.
    db.run(
      `insert into session_deltas(
         session_id, project_id, lane_id, started_at, ended_at, files_changed,
         insertions, deletions, touched_files_json, failure_lines_json, computed_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["session-2", "project-1", "lane-1", "2026-07-07T09:00:00.000Z", "2026-07-07T09:05:00.000Z", 2, 0, 0, "[]", "[]", "2026-07-07T09:06:00.000Z"],
    );
    db.run(
      `insert into ai_usage_log(id, timestamp, feature, provider, model, input_tokens, output_tokens, duration_ms, success, session_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "ai-1", "2026-07-08T12:01:00.000Z", "chat", "claude", "sonnet", 100, 50, 1_000, 1, "session-1",
        "ai-2", "2026-07-08T12:02:00.000Z", "chat", "claude", "opus", 20, 10, 500, 0, "session-1",
      ],
    );
    db.run(
      `insert into operations(id, project_id, lane_id, kind, started_at, ended_at, status)
       values (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?),
              (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      [
        "op-1", "project-1", "lane-1", "git_commit", "2026-07-08T12:20:00.000Z", "2026-07-08T12:20:01.000Z", "succeeded",
        "op-2", "project-1", "lane-1", "git_push", "2026-07-08T12:21:00.000Z", "2026-07-08T12:21:01.000Z", "succeeded",
        "op-3", "project-1", "lane-1", "git_commit", "2026-07-08T12:22:00.000Z", "2026-07-08T12:22:01.000Z", "failed",
        "op-4", "project-1", "lane-1", "pr_land", "2026-07-08T12:23:00.000Z", "2026-07-08T12:23:01.000Z", "succeeded",
      ],
    );
    recordUsageInteraction(db, { projectId: "project-1", client: "desktop", action: "chat.send", sessionId: "session-1", occurredAt: "2026-07-08T12:05:00.000Z" });
    recordUsageInteraction(db, { projectId: "project-1", client: "mobile", action: "git.push", sessionId: "session-1", occurredAt: "2026-07-08T12:21:00.000Z" });

    const stats = collectAdeDatabaseUsageStats(db, {
      since: "2026-07-07T00:00:00.000Z",
      until: "2026-07-09T00:00:00.000Z",
    });

    expect(stats?.summary).toMatchObject({
      trackedAdeTokens: 180,
      trackedAdeCalls: 2,
      trackedAdeDurationMs: 1_500,
      chatSessions: 1,
      commitsCreated: 1,
      pushOperations: 1,
      prLandings: 1,
      filesChanged: 5,
      insertions: 120,
      deletions: 20,
      totalInteractions: 2,
      // The file-only (rename/mode) delta day must count as active even with
      // zero insertions/deletions — it contributes to filesChanged above.
      activeDays: 2,
      longestSessionMs: 1_800_000,
    });
    expect(stats?.features).toEqual([
      expect.objectContaining({ feature: "chat", provider: "claude", calls: 2, successRate: 50 }),
    ]);
    expect(stats?.clients).toEqual([
      expect.objectContaining({ client: "desktop", interactions: 1 }),
      expect.objectContaining({ client: "mobile", interactions: 1 }),
    ]);
    expect(stats?.daily).toEqual([
      expect.objectContaining({
        date: "2026-07-07",
        filesChanged: 2,
        insertions: 0,
        deletions: 0,
      }),
      expect.objectContaining({
        date: "2026-07-08",
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
        durationMs: 1_500,
        sessions: 1,
        filesChanged: 3,
        commits: 1,
        prs: 1,
        interactions: 2,
        clients: { desktop: 1, mobile: 1 },
      }),
    ]);
  });

  it("normalizes client actions while excluding reads and terminal keystrokes", async () => {
    const db = await createStatsDb();
    expect(usageClientSurfaceFromRpcName("ade-desktop")).toBe("desktop");
    expect(usageClientSurfaceFromRpcName("ade-code")).toBe("tui");
    expect(usageClientSurfaceFromRpcName("ade-web-client")).toBe("web");
    expect(usageClientSurfaceFromPeer("phone", "ios")).toBe("mobile");
    expect(usageActionFromIpcChannel("ade.agentChat.send")).toBe("chat.send");
    expect(usageActionFromIpcChannel("ade.agentChat.scheduledWork.create")).toBe("chat.createScheduledWork");
    expect(isMeaningfulUsageAction("chat.createScheduledWork")).toBe(true);
    expect(usageActionFromIpcChannel("ade.agentChat.scheduledWork.cancel")).toBe("chat.cancelScheduledWork");
    expect(isMeaningfulUsageAction("chat.cancelScheduledWork")).toBe(true);
    expect(usageActionFromIpcChannel("ade.agentChat.promptStashes.create")).toBe("chat.createPromptStash");
    expect(isMeaningfulUsageAction("chat.createPromptStash")).toBe(true);
    expect(usageActionFromIpcChannel("ade.pty.create")).toBe("work.startCliSession");
    expect(usageActionFromRpcDomain("lane", "create")).toBe("lanes.create");
    expect(isMeaningfulUsageAction(usageActionFromRpcDomain("lane", "archiveAndReclaim"))).toBe(true);
    expect(usageActionFromRpcDomain("file", "writeWorkspaceText")).toBe("files.writeText");
    expect(usageActionFromRpcDomain("pty", "write")).toBe("pty.write");
    expect(isMeaningfulUsageAction(usageActionFromRpcDomain("pty", "write"))).toBe(false);
    expect(usageActionFromRpcDomain("external-sessions", "import")).toBe("work.importExternalSession");
    // Settle lifecycle: single + bulk, IPC + RPC, all collapse to one coarse
    // meaningful action per direction.
    expect(usageActionFromIpcChannel("ade.sessions.settle")).toBe("work.settleSession");
    expect(usageActionFromIpcChannel("ade.sessions.settleMany")).toBe("work.settleSession");
    expect(usageActionFromIpcChannel("ade.sessions.unsettleMany")).toBe("work.unsettleSession");
    expect(usageActionFromRpcDomain("session", "settleSession")).toBe("work.settleSession");
    expect(usageActionFromRpcDomain("session", "unsettleSessions")).toBe("work.unsettleSession");
    expect(isMeaningfulUsageAction("work.settleSession")).toBe(true);
    expect(isMeaningfulUsageAction("work.unsettleSession")).toBe(true);
    // Reads and note-writes stay untracked (agent-frequency mechanics).
    expect(isMeaningfulUsageAction(usageActionFromRpcDomain("session", "setSessionStatusNote"))).toBe(false);

    recordUsageInteraction(db, { client: "desktop", action: "lanes.list" });
    expect(db.get<{ count: number }>("select count(*) count from usage_events")?.count).toBe(0);
  });
});

describe("usage ledger end-to-end accuracy", () => {
  type TokenTotals = { input: number; output: number; cached: number; cacheWrite: number };
  type TokenBreakdownValue = Omit<TokenTotals, "cacheWrite"> & { cacheWrite?: number };

  function writeJsonl(filePath: string, records: unknown[], mtime: Date): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    fs.utimesSync(filePath, mtime, mtime);
  }

  function sumBreakdown(breakdown: Record<string, TokenBreakdownValue> | undefined): TokenTotals {
    return Object.values(breakdown ?? {}).reduce<TokenTotals>((total, model) => ({
      input: total.input + model.input,
      output: total.output + model.output,
      cached: total.cached + model.cached,
      cacheWrite: total.cacheWrite + (model.cacheWrite ?? 0),
    }), { input: 0, output: 0, cached: 0, cacheWrite: 0 });
  }

  function totalsFor(snapshot: CostSnapshot): TokenTotals {
    return sumBreakdown(snapshot.tokenBreakdownByPreset?.all);
  }

  function dailyTotalsFor(snapshot: CostSnapshot): Record<string, TokenTotals> {
    return Object.fromEntries(Object.entries(snapshot.dailyTokenBreakdownByPreset?.all ?? {})
      .map(([day, breakdown]) => [day, sumBreakdown(breakdown)]));
  }

  function totalTokens(totals: TokenTotals): number {
    return totals.input + totals.output + totals.cached + totals.cacheWrite;
  }

  function snapshotsByProvider(snapshots: CostSnapshot[]): Record<string, CostSnapshot> {
    return Object.fromEntries(snapshots.map((snapshot) => [snapshot.provider, snapshot]));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches independently calculated provider, day, scope, origin, and estimation totals", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-usage-e2e-"));
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalClaudeConfigDirs = process.env.CLAUDE_CONFIG_DIRS;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalFactoryDir = process.env.FACTORY_DIR;
    try {
      const beforeMidnight = new Date(2026, 9, 31, 23, 59, 0, 0);
      const afterMidnight = new Date(2026, 10, 1, 0, 1, 0, 0);
      const beforeDstChange = new Date(2026, 10, 1, 0, 30, 0, 0);
      const afterDstChange = new Date(2026, 10, 1, 3, 30, 0, 0);
      const today = new Date(2026, 10, 2, 9, 0, 0, 0);
      const now = new Date(2026, 10, 2, 12, 0, 0, 0);
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const projectA = path.join(tmpDir, "project-a");
      const projectB = path.join(tmpDir, "project-b");
      const claudeConfigDir = path.join(tmpDir, "claude");
      const claudeProjectA = path.join(claudeConfigDir, "projects", sanitizeClaudeProjectPath(projectA));
      const claudeProjectB = path.join(claudeConfigDir, "projects", sanitizeClaudeProjectPath(projectB));
      const claudeEntry = ({
        id,
        timestamp,
        cwd,
        input,
        output,
        cacheRead = 0,
        cacheWrite = 0,
        cache5m,
        cache1h,
      }: {
        id: string;
        timestamp: Date;
        cwd: string;
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
        cache5m?: number;
        cache1h?: number;
      }) => ({
        type: "assistant",
        timestamp: timestamp.toISOString(),
        cwd,
        message: {
          id,
          model: "claude-opus-4-6",
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite,
            ...(cache5m != null || cache1h != null ? {
              cache_creation: {
                ephemeral_5m_input_tokens: cache5m ?? 0,
                ephemeral_1h_input_tokens: cache1h ?? 0,
              },
            } : {}),
            server_tool_use: { web_search_requests: 1 },
          },
        },
      });

      const resumedClaudeMessage = claudeEntry({
        id: "claude-resume",
        timestamp: beforeMidnight,
        cwd: projectA,
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
      });
      writeJsonl(path.join(claudeProjectA, "session-a.jsonl"), [
        resumedClaudeMessage,
        claudeEntry({ id: "claude-stream", timestamp: afterMidnight, cwd: projectA, input: 20, output: 4, cacheRead: 5, cacheWrite: 4 }),
        claudeEntry({ id: "claude-stream", timestamp: new Date(2026, 10, 1, 0, 2), cwd: projectA, input: 30, output: 7, cacheRead: 8, cacheWrite: 6 }),
        claudeEntry({
          id: "claude-stream",
          timestamp: new Date(2026, 10, 1, 0, 3),
          cwd: projectA,
          input: 40,
          output: 9,
          cacheRead: 10,
          cacheWrite: 7,
          cache5m: 3,
          cache1h: 5,
        }),
      ], now);
      writeJsonl(path.join(claudeProjectA, "session-b.jsonl"), [
        resumedClaudeMessage,
        claudeEntry({
          id: "claude-ade",
          timestamp: afterDstChange,
          cwd: path.join(projectA, ".ade", "worktrees", "lane-a"),
          input: 11,
          output: 4,
          cacheRead: 2,
          cacheWrite: 3,
        }),
      ], new Date(now.getTime() - 1_000));
      writeJsonl(path.join(claudeProjectA, "subagents", "workflows", "wf-1", "agent-explore.jsonl"), [
        claudeEntry({ id: "claude-subagent", timestamp: new Date(2026, 10, 1, 3, 45), cwd: projectA, input: 7, output: 3, cacheRead: 1, cacheWrite: 2 }),
      ], new Date(now.getTime() - 2_000));
      writeJsonl(path.join(claudeProjectB, "session-c.jsonl"), [
        claudeEntry({ id: "claude-project-b", timestamp: today, cwd: projectB, input: 13, output: 5, cacheRead: 4, cacheWrite: 6 }),
      ], new Date(now.getTime() - 3_000));

      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      delete process.env.CLAUDE_CONFIG_DIRS;

      const codexHome = path.join(tmpDir, "codex");
      const codexSessions = path.join(codexHome, "sessions", "2026", "11", "01");
      const codexUsage = ({ timestamp, input, cached, output, reasoning, total }: {
        timestamp: Date;
        input: number;
        cached: number;
        output: number;
        reasoning: number;
        total: number;
      }) => ({
        timestamp: timestamp.toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: total,
            },
            last_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: total,
            },
          },
        },
      });
      writeJsonl(path.join(codexSessions, "parent.jsonl"), [
        { type: "session_meta", payload: { id: "codex-parent", originator: "codex_cli_rs", cwd: projectA, model: "gpt-5.5" } },
        codexUsage({ timestamp: beforeDstChange, input: 50, cached: 10, output: 5, reasoning: 1, total: 56 }),
      ], now);
      writeJsonl(path.join(codexSessions, "fork.jsonl"), [
        { type: "session_meta", payload: { id: "codex-fork", forked_from_id: "codex-parent", originator: "ade_desktop", cwd: projectA, model: "gpt-5.5" } },
        codexUsage({ timestamp: new Date(2026, 10, 1, 3, 1), input: 50, cached: 10, output: 5, reasoning: 1, total: 56 }),
        {
          ...codexUsage({ timestamp: new Date(2026, 10, 1, 3, 15), input: 70, cached: 15, output: 8, reasoning: 2, total: 80 }),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 70, cached_input_tokens: 15, output_tokens: 8, reasoning_output_tokens: 2, total_tokens: 80 },
              last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 24 },
            },
          },
        },
      ], new Date(now.getTime() - 1_000));
      writeJsonl(path.join(codexHome, "sessions", "2026", "11", "02", "external-b.jsonl"), [
        { type: "session_meta", payload: { id: "codex-project-b", originator: "codex_cli_rs", cwd: projectB, model: "gpt-5.5" } },
        codexUsage({ timestamp: new Date(2026, 10, 2, 9, 15), input: 30, cached: 6, output: 4, reasoning: 0, total: 34 }),
      ], new Date(now.getTime() - 2_000));
      process.env.CODEX_HOME = codexHome;

      const cursorDbPath = path.join(tmpDir, "cursor", "state.vscdb");
      fs.mkdirSync(path.dirname(cursorDbPath), { recursive: true });
      const { DatabaseSync } = requireForTest("node:sqlite") as {
        DatabaseSync: new (dbPath: string) => {
          exec: (sql: string) => void;
          prepare: (sql: string) => { run: (...args: unknown[]) => void };
          close: () => void;
        };
      };
      const cursorDb = new DatabaseSync(cursorDbPath);
      cursorDb.exec("create table cursorDiskKV (key text, value text);");
      const insertCursor = cursorDb.prepare("insert into cursorDiskKV values (?, ?)");
      insertCursor.run("bubbleId:cursor-1", JSON.stringify({
        createdAt: new Date(2026, 10, 1, 0, 40).toISOString(),
        tokenCount: { inputTokens: 12, outputTokens: 3 },
        modelInfo: { modelName: "cursor-auto" },
        type: 1,
        text: "native",
      }));
      insertCursor.run("bubbleId:cursor-2", JSON.stringify({
        createdAt: new Date(2026, 10, 1, 3, 40).toISOString(),
        tokenCount: {},
        modelInfo: { modelName: "default" },
        type: 2,
        text: "abcdefghijklmnop",
      }));
      cursorDb.close();

      const geminiTmp = path.join(tmpDir, "gemini", "tmp");
      writeJsonl(path.join(geminiTmp, "project-a", "chats", "session-gemini.jsonl"), [
        { sessionId: "gemini-session", startTime: afterMidnight.toISOString(), projectHash: "project-a" },
        { id: "gemini-before-dst", type: "gemini", timestamp: new Date(2026, 10, 1, 0, 45).toISOString(), model: "gemini-3.1-pro-preview", tokens: { input: 30, output: 7, cached: 5, thoughts: 2 } },
        { id: "gemini-after-dst", type: "gemini", timestamp: new Date(2026, 10, 1, 3, 15).toISOString(), model: "gemini-3.1-pro-preview", tokens: { input: 20, output: 5, cached: 4, thoughts: 1 } },
      ], now);

      const factoryDir = path.join(tmpDir, "factory");
      const droidSession = path.join(factoryDir, "sessions", "project-a", "session-droid.jsonl");
      writeJsonl(droidSession, [
        { type: "session_start", id: "droid-session", cwd: projectA },
        { type: "message", id: "droid-before-dst", timestamp: new Date(2026, 10, 1, 0, 50).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "before" }] } },
        { type: "message", id: "droid-after-dst", timestamp: new Date(2026, 10, 1, 3, 20).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", name: "Execute" }] } },
      ], now);
      fs.writeFileSync(droidSession.replace(/\.jsonl$/, ".settings.json"), JSON.stringify({
        model: "custom:[anthropic]-claude-sonnet-5-20260501",
        tokenUsage: { inputTokens: 21, outputTokens: 9, thinkingTokens: 3, cacheReadTokens: 5, cacheCreationTokens: 3 },
      }));
      process.env.FACTORY_DIR = factoryDir;

      const entriesByProvider = new Map<string, TokenEntry[]>([
        ["claude", await scanClaudeLogs([claudeProjectA, claudeProjectB])],
        ["codex", await scanCodexLogs()],
        ["cursor", await scanCursorLogs(cursorDbPath)],
        ["gemini", await scanGeminiLogs(geminiTmp)],
        ["droid", await scanDroidLogs()],
      ]);
      const machine = snapshotsByProvider(buildCostSnapshots(entriesByProvider, "machine", projectA));
      const project = snapshotsByProvider(buildCostSnapshots(entriesByProvider, "project", projectA));

      const expectedMachineTotals: Record<string, TokenTotals> = {
        claude: { input: 81, output: 23, cached: 20, cacheWrite: 23 },
        codex: { input: 79, output: 12, cached: 21, cacheWrite: 0 },
        cursor: { input: 12, output: 7, cached: 0, cacheWrite: 0 },
        // Gemini "thoughts" bill as output but are not output, so the display
        // total carries only the 12 real output tokens.
        gemini: { input: 41, output: 12, cached: 9, cacheWrite: 0 },
        // Droid "thinking" tokens bill as output but are not output, so the
        // display total carries only the 9 real output tokens.
        droid: { input: 21, output: 9, cached: 5, cacheWrite: 3 },
      };
      const expectedProjectTotals: Record<string, TokenTotals> = {
        claude: { input: 68, output: 18, cached: 16, cacheWrite: 17 },
        codex: { input: 55, output: 8, cached: 15, cacheWrite: 0 },
        // Cursor's IDE ledger records no workspace, so it stays machine-only
        // and reports a zero row flagged `scopeSupported: false`.
        cursor: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
        // Droid records `cwd` on `session_start`, so its project-A session now
        // counts in project scope instead of vanishing from it.
        droid: { input: 21, output: 9, cached: 5, cacheWrite: 3 },
      };
      const expectedDailyTotals: Record<string, Record<string, TokenTotals>> = {
        claude: {
          "2026-10-31": { input: 10, output: 2, cached: 3, cacheWrite: 4 },
          "2026-11-01": { input: 58, output: 16, cached: 13, cacheWrite: 13 },
          "2026-11-02": { input: 13, output: 5, cached: 4, cacheWrite: 6 },
        },
        codex: {
          "2026-11-01": { input: 55, output: 8, cached: 15, cacheWrite: 0 },
          "2026-11-02": { input: 24, output: 4, cached: 6, cacheWrite: 0 },
        },
        cursor: { "2026-11-01": { input: 12, output: 7, cached: 0, cacheWrite: 0 } },
        gemini: { "2026-11-01": { input: 41, output: 12, cached: 9, cacheWrite: 0 } },
        droid: { "2026-11-01": { input: 21, output: 9, cached: 5, cacheWrite: 3 } },
      };

      for (const provider of Object.keys(expectedMachineTotals)) {
        expect(totalsFor(machine[provider]!), `${provider} machine totals`).toEqual(expectedMachineTotals[provider]);
        expect(dailyTotalsFor(machine[provider]!), `${provider} daily totals`).toEqual(expectedDailyTotals[provider]);
      }
      // A provider that CAN be project-scoped and contributed nothing to this
      // project is absent from project scope rather than listed at zero; one
      // that cannot be scoped at all is listed at zero so the page can say so.
      // Gemini's fixture writes no `.project_root`, so it is unattributable
      // here and drops out.
      expect(Object.keys(project).sort()).toEqual(["claude", "codex", "cursor", "droid"]);
      expect(project.cursor?.scopeSupported).toBe(false);
      for (const provider of Object.keys(expectedProjectTotals)) {
        expect(totalsFor(project[provider]!), `${provider} project totals`).toEqual(expectedProjectTotals[provider]);
      }

      expect(Object.fromEntries(Object.entries(machine).map(([provider, snapshot]) => {
        const total = totalTokens(totalsFor(snapshot));
        const ade = snapshot.adeOriginatedTokensByPreset?.all ?? 0;
        return [provider, { ade, external: total - ade }];
      }))).toEqual({
        claude: { ade: 20, external: 127 },
        codex: { ade: 23, external: 89 },
        cursor: { ade: 0, external: 19 },
        // Gemini "thoughts" (3) and Droid "thinking" (3) are billed as output but
        // are not output, so they no longer inflate the displayed token totals.
        gemini: { ade: 0, external: 62 },
        droid: { ade: 0, external: 38 },
      });

      expect(Object.fromEntries(Object.entries(machine).map(([provider, snapshot]) => [provider, {
        estimation: snapshot.estimation ?? null,
        scopeSupported: snapshot.scopeSupported,
      }]))).toEqual({
        // Only Cursor's IDE ledger genuinely records no workspace; every other
        // agent CLI writes its cwd somewhere the ledger readers now capture.
        claude: { estimation: null, scopeSupported: true },
        codex: { estimation: null, scopeSupported: true },
        cursor: { estimation: "mixed", scopeSupported: false },
        gemini: { estimation: null, scopeSupported: true },
        droid: { estimation: "distribution", scopeSupported: true },
      });

      const wallClockDeltaMs = 3 * 60 * 60 * 1_000;
      const offsetChangeMs = (afterDstChange.getTimezoneOffset() - beforeDstChange.getTimezoneOffset()) * 60 * 1_000;
      expect(afterDstChange.getTime() - beforeDstChange.getTime()).toBe(wallClockDeltaMs + offsetChangeMs);
    } finally {
      const restoreEnv = (key: "CLAUDE_CONFIG_DIR" | "CLAUDE_CONFIG_DIRS" | "CODEX_HOME" | "FACTORY_DIR", value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restoreEnv("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
      restoreEnv("CLAUDE_CONFIG_DIRS", originalClaudeConfigDirs);
      restoreEnv("CODEX_HOME", originalCodexHome);
      restoreEnv("FACTORY_DIR", originalFactoryDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const ALL_PRESETS = ["today", "7d", "30d", "year", "all"] as const;
  const round2 = (value: number): number => Math.round(value * 100) / 100;
  const makeSnapshot = (overrides: { costs: CostSnapshot[] }) => ({
    windows: [],
    pacing: calculatePacing([]),
    costs: overrides.costs,
    adeCosts: [],
    extraUsage: [],
    lastPolledAt: new Date().toISOString(),
    errors: [],
  } as never);

  it("keeps model rows, provider rows and the range total in agreement across every preset", () => {
    // Costs were rounded to cents on every accumulate, so a provider's total
    // was the sum of its own rounding steps and each model row the sum of a
    // different set: the rows stopped adding up to the provider they belong to.
    const entries: TokenEntry[] = [];
    const base = Date.now();
    for (let index = 0; index < 60; index += 1) {
      entries.push({
        messageId: `rounding-${index}`,
        model: index % 3 === 0 ? "claude-opus-5" : index % 3 === 1 ? "claude-sonnet-5" : "claude-haiku-4-5",
        inputTokens: 1_001 + index,
        outputTokens: 307 + index,
        cachedTokens: 5_003 + index,
        cacheWriteTokens: 101 + index,
        timestamp: base - index * 60 * 60 * 1000,
      });
    }
    const costs = buildCostSnapshots(new Map([["claude", entries]]), "machine", null);

    for (const preset of ALL_PRESETS) {
      const stats = collectAdeUsageStats({
        snapshot: makeSnapshot({ costs }),
        args: { preset },
        nowMs: base,
      });
      const providerCost = stats.providers.reduce((sum, provider) => sum + provider.rangeCostUsd, 0);
      const providerTokens = stats.providers.reduce((sum, provider) => sum + provider.totalTokens, 0);
      const modelTokens = stats.models.reduce((sum, model) => sum + model.totalTokens, 0);
      expect(round2(providerCost), `${preset} providers vs range total`)
        .toBe(stats.summary.observedProviderCostRangeUsd);
      expect(providerTokens, `${preset} provider tokens vs summary`).toBe(stats.summary.observedProviderTokens);
      expect(modelTokens, `${preset} model tokens vs provider tokens`).toBe(providerTokens);
      // Per-row display rounding is inherent; the rows must still land within
      // half a cent of their provider rather than drifting by a cent per row.
      const modelCost = stats.models.reduce((sum, model) => sum + model.costUsd, 0);
      expect(Math.abs(modelCost - providerCost), `${preset} models vs providers`)
        .toBeLessThanOrEqual(0.005 * stats.models.length);
    }
  });

  it("gives every day's tokens a provider so the chart series sum to the day total", () => {
    const base = Date.now();
    const costs = buildCostSnapshots(new Map([
      ["claude", [{
        messageId: "graph-claude",
        model: "claude-opus-5",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 40,
        cacheWriteTokens: 10,
        timestamp: base,
      }]],
      ["droid", [{
        messageId: "graph-droid",
        model: "claude-opus-4-6",
        inputTokens: 50,
        outputTokens: 5,
        cachedTokens: 7,
        cacheWriteTokens: 0,
        timestamp: base,
      }]],
    ]), "machine", null);

    for (const preset of ALL_PRESETS) {
      const stats = collectAdeUsageStats({
        snapshot: makeSnapshot({ costs }),
        args: { preset },
        nowMs: base,
      });
      for (const point of stats.daily) {
        const attributed = Object.values(point.byProvider ?? {})
          .reduce((sum, entry) => sum + entry.totalTokens, 0);
        expect(attributed, `${preset} ${point.date} byProvider vs totalTokens`).toBe(point.totalTokens);
      }
      const day = stats.daily.find((point) => point.totalTokens > 0);
      expect(Object.keys(day?.byProvider ?? {}).sort()).toEqual(["claude", "droid"]);
    }
  });

  it("attributes a database-gap-filled day to a provider instead of raising an unattributed total", () => {
    const nowMs = Date.now();
    const stats = collectAdeUsageStats({
      snapshot: makeSnapshot({ costs: [] }),
      databaseStats: {
        summary: {} as never,
        providers: [], models: [], agentProviders: [], agentModels: [],
        features: [], lanes: [], activities: [], clients: [],
        daily: [{
          date: localDayKey(nowMs),
          inputTokens: 400,
          outputTokens: 100,
          totalTokens: 500,
          byProvider: { codex: { totalTokens: 500, costUsd: 0 } },
        }],
      } as never,
      args: { preset: "today" },
      nowMs,
    });
    const point = stats.daily.find((entry) => entry.date === localDayKey(nowMs));
    expect(point?.totalTokens).toBe(500);
    expect(point?.byProvider).toEqual({ codex: { totalTokens: 500, costUsd: 0 } });
  });
});
