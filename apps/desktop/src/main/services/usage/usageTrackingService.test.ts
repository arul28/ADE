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

const {
  aggregateCosts,
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
  parseCodexRateLimitWindows,
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

describe("parseCodexRateLimitWindows", () => {
  it("accepts the wham HTTP response shape", () => {
    const result = parseCodexRateLimitWindows({
      rate_limit: {
        primary_window: { used_percent: 15, reset_at: 1773446952 },
        secondary_window: { used_percent: 63, reset_at: 1773853354 },
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

  it("does not spawn the CLI fallback for non-auth Codex 4xx responses", async () => {
    const tmpDir = makeTmpDir();
    const originalCodexHome = process.env.CODEX_HOME;
    fs.writeFileSync(path.join(tmpDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "rate-limited-token" },
    }));
    process.env.CODEX_HOME = tmpDir;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    }));

    try {
      const logger = createLogger();
      const result = await pollCodexUsage(logger as any);

      expect(result.windows).toEqual([]);
      expect(result.errors).toEqual(["codex: API returned 429"]);
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

  it("merges app-server daily usage and workspace messages when HTTP rate-limit windows succeed", async () => {
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
      expect(result.dailyUsage7d?.some((value) => value === 123)).toBe(true);
      expect(result.providerMessages).toEqual([
        expect.objectContaining({
          provider: "codex",
          id: "msg-1",
          kind: "headline",
          message: "Native usage ready",
        }),
      ]);
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

  it("clamps out-of-range poll intervals internally", () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const service1 = createUsageTrackingService({ logger, pollIntervalMs: 100, dependencies });
    service1.start();
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), MIN_POLL_INTERVAL_MS);
    service1.dispose();

    const service2 = createUsageTrackingService({ logger, pollIntervalMs: 60 * 60 * 1000, dependencies });
    service2.start();
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_POLL_INTERVAL_MS);
    service2.dispose();

    setIntervalSpy.mockRestore();
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

  it("forceRefresh invalidates cost cache and re-polls", async () => {
    const logger = createLogger();
    const dependencies = createFastDependencies();
    const service = createUsageTrackingService({ logger, dependencies });

    const s1 = await service.forceRefresh();
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

  it("waits for a startup no-cost poll before running an explicit cost refresh", async () => {
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

    const refresh = service.forceRefresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(dependencies.scanClaudeLogs).not.toHaveBeenCalled();

    resolveStartupPoll({ windows: [] as never[], extraUsage: null, errors: [] as never[] });
    await expect(refresh).resolves.toBeDefined();

    expect(dependencies.pollClaudeUsage).toHaveBeenCalledTimes(2);
    expect(dependencies.scanClaudeLogs).toHaveBeenCalledTimes(1);
    expect(dependencies.scanCodexLogs).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("keeps GitHub stats cache entries precise for same-day custom ranges", async () => {
    const logger = createLogger();
    const scanGitHubStats = vi.fn(async (range: any) => ({
      repo: "arul28/ADE",
      available: true,
      fetchedAt: range.until,
      error: null,
      commitsCreated: new Date(range.until).getUTCHours(),
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

    const firstLoading = await service.getAdeUsageStats({
      preset: "today",
      since: "2026-05-30T00:00:00.000Z",
      until: "2026-05-30T10:00:00.000Z",
    });
    await vi.waitFor(() => expect(scanGitHubStats).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    const first = await service.getAdeUsageStats({
      preset: "today",
      since: "2026-05-30T00:00:00.000Z",
      until: "2026-05-30T10:00:00.000Z",
    });
    const secondLoading = await service.getAdeUsageStats({
      preset: "today",
      since: "2026-05-30T00:00:00.000Z",
      until: "2026-05-30T11:00:00.000Z",
    });
    await vi.waitFor(() => expect(scanGitHubStats).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    const second = await service.getAdeUsageStats({
      preset: "today",
      since: "2026-05-30T00:00:00.000Z",
      until: "2026-05-30T11:00:00.000Z",
    });

    expect(firstLoading.freshness?.state).toBe("refreshing");
    expect(secondLoading.freshness?.state).toBe("refreshing");
    expect(first.githubActivity?.commits).toBe(10);
    expect(second.githubActivity?.commits).toBe(11);
    expect(scanGitHubStats).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it("clamps inverted custom ranges before scanning GitHub stats", async () => {
    const logger = createLogger();
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
      since: "2026-05-31T00:00:00.000Z",
      until: "2026-05-30T00:00:00.000Z",
    });

    expect(scanGitHubStats).toHaveBeenCalledWith(expect.objectContaining({
      since: "2026-05-30T00:00:00.000Z",
      until: "2026-05-30T00:00:00.000Z",
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

    const snapshot = await service.forceRefresh();

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
    await service.forceRefresh();

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
    const snapshot = await service.forceRefresh();
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
});

describe("scanCodexLogs", () => {
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
                total_token_usage: {
                  input_tokens: 1200,
                  cached_input_tokens: 300,
                  output_tokens: 80,
                  reasoning_output_tokens: 20,
                  total_tokens: 1300,
                },
                last_token_usage: {
                  input_tokens: 1200,
                  cached_input_tokens: 300,
                  output_tokens: 80,
                  reasoning_output_tokens: 20,
                  total_tokens: 1300,
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
        billableOutputTokens: 100,
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
      fs.truncateSync(filePath, 769 * 1024 * 1024);

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
      expect(entries[0]).toMatchObject({
        model: "claude-sonnet-5",
        inputTokens: 50,
        outputTokens: 21,
        cachedTokens: 4,
        billableCachedTokens: 4,
        cacheWriteTokens: 2,
      });
      expect(entries[1]).toMatchObject({
        inputTokens: 51,
        outputTokens: 22,
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
        outputTokens: 35,
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
        outputTokens: 23,
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
    const result = buildProviderWindows("claude", fresh, [], [], null, "2026-06-07T00:00:00Z");
    expect(result.status.state).toBe("ok");
    expect(result.status.lastSuccessAt).toBe("2026-06-07T00:00:00Z");
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
    expect(result.status.state).toBe("error");
    expect(result.status.message).toMatch(/sign-in expired|reconnect/i);
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

    const first = await service.poll({ includeCosts: false });
    expect(first.windows.filter((w) => w.provider === "claude")).toHaveLength(1);
    expect(first.extraUsage).toEqual([claudeExtraUsage]);
    expect(first.providerStatus?.claude?.state).toBe("ok");

    const second = await service.poll({ includeCosts: false });
    const claudeWindows = second.windows.filter((w) => w.provider === "claude");
    expect(claudeWindows).toHaveLength(1);
    expect(claudeWindows[0]?.percentUsed).toBe(40);
    expect(second.extraUsage).toEqual([claudeExtraUsage]);
    expect(second.providerStatus?.claude?.state).toBe("stale");
    expect(second.providerStatus?.claude?.lastSuccessAt).toBe(first.lastPolledAt);

    service.dispose();
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

    const snap = await service.poll({ includeCosts: false });
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

  it("caps raw daily bucket scans newest-first without throwing", async () => {
    const db = await createStatsDb();
    const logger = createLogger();
    const originalAll = db.all.bind(db);
    const newestRow = {
      timestamp: "2026-07-08T12:00:00.000Z",
      input_tokens: 1,
      output_tokens: 0,
      duration_ms: 0,
    };
    const oldestRow = {
      ...newestRow,
      timestamp: "2026-07-07T12:00:00.000Z",
    };
    const rowsBeyondCap = Array(250_001).fill(newestRow);
    rowsBeyondCap[0] = oldestRow;
    let checkedClientQuery = false;
    let checkedOperationQuery = false;
    let checkedAiQuery = false;
    const cappedDb: AdeDb = {
      ...db,
      all: ((sql: string, params = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.startsWith("select occurred_at, client_surface")) {
          expect(normalized).toContain("order by occurred_at desc limit ?");
          checkedClientQuery = true;
        }
        if (normalized.startsWith("select started_at, kind")) {
          expect(normalized).toContain("order by started_at desc limit ?");
          checkedOperationQuery = true;
        }
        if (normalized.startsWith("select timestamp,")) {
          expect(normalized).toContain("order by timestamp desc limit ?");
          const limit = Number(params.at(-1));
          expect(rowsBeyondCap.length).toBeGreaterThan(limit);
          checkedAiQuery = true;
          return rowsBeyondCap.slice(1, limit + 1);
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
    }));
    expect(stats?.daily.some((point) => point.date === "2026-07-07")).toBe(false);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith("usage.daily_bucket_scan_capped", {
      maxRows: 250_000,
      sources: ["ai_usage_log"],
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
       values (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      [
        "op-1", "project-1", "lane-1", "git_commit", "2026-07-08T12:20:00.000Z", "2026-07-08T12:20:01.000Z", "succeeded",
        "op-2", "project-1", "lane-1", "git_push", "2026-07-08T12:21:00.000Z", "2026-07-08T12:21:01.000Z", "succeeded",
        "op-3", "project-1", "lane-1", "git_commit", "2026-07-08T12:22:00.000Z", "2026-07-08T12:22:01.000Z", "failed",
      ],
    );
    recordUsageInteraction(db, { projectId: "project-1", client: "desktop", action: "chat.send", sessionId: "session-1", occurredAt: "2026-07-08T12:05:00.000Z" });
    recordUsageInteraction(db, { projectId: "project-1", client: "mobile", action: "git.push", sessionId: "session-1", occurredAt: "2026-07-08T12:21:00.000Z" });

    const stats = collectAdeDatabaseUsageStats(db, {
      since: "2026-07-08T00:00:00.000Z",
      until: "2026-07-09T00:00:00.000Z",
    });

    expect(stats?.summary).toMatchObject({
      trackedAdeTokens: 180,
      trackedAdeCalls: 2,
      trackedAdeDurationMs: 1_500,
      chatSessions: 1,
      commitsCreated: 1,
      pushOperations: 1,
      filesChanged: 3,
      insertions: 120,
      deletions: 20,
      totalInteractions: 2,
      activeDays: 1,
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
        date: "2026-07-08",
        totalTokens: 180,
        sessions: 1,
        filesChanged: 3,
        commits: 1,
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
    expect(usageActionFromIpcChannel("ade.pty.create")).toBe("work.startCliSession");
    expect(usageActionFromRpcDomain("lane", "create")).toBe("lanes.create");
    expect(usageActionFromRpcDomain("pr", "createQueuePrs")).toBe("prs.createQueue");
    expect(usageActionFromRpcDomain("file", "writeWorkspaceText")).toBe("files.writeText");
    expect(usageActionFromRpcDomain("process", "restartStack")).toBe("processes.start");
    expect(usageActionFromRpcDomain("pty", "write")).toBe("pty.write");
    expect(isMeaningfulUsageAction(usageActionFromRpcDomain("pty", "write"))).toBe(false);
    expect(usageActionFromRpcDomain("external-sessions", "import")).toBe("work.importExternalSession");

    recordUsageInteraction(db, { client: "desktop", action: "lanes.list" });
    expect(db.get<{ count: number }>("select count(*) count from usage_events")?.count).toBe(0);
  });
});
