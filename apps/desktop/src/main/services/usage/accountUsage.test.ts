import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdeAccountMachinesResult,
  AdeUsageRollup,
  AdeUsageRollupRow,
  AdeUsageStats,
  CostSnapshot,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import {
  ACCOUNT_ROLLUP_STALE_AFTER_MS,
  buildRollupRows,
  mergeAccountUsageStats,
  resolveContributions,
  type AccountUsageContribution,
} from "./accountUsageRollup";
import { createAccountUsageRollupStore, ROLLUP_RETAINED_DAYS } from "./accountUsageRollupStore";
import { createAccountRollupFetcher } from "./accountUsageLiveRefresh";
import {
  buildTranscriptSource,
  isSameTranscriptSource,
  readOrCreateUsageSourceId,
  transcriptRootDigest,
  type UsageSourceFsApi,
} from "./accountUsageSource";
import {
  getOrCreateLocalAccountMachineIdentity,
  isCreateContention,
} from "../account/localMachineIdentity";
import { localDayKey } from "./localDay";
import { createUsageTrackingService } from "./usageTrackingService";

const NOW_MS = Date.parse("2026-08-09T18:00:00.000Z");
const TODAY = localDayKey(NOW_MS);
const YESTERDAY = localDayKey(NOW_MS - 86_400_000);

function makeStats(overrides: Partial<AdeUsageStats> = {}): AdeUsageStats {
  return {
    generatedAt: new Date(NOW_MS).toISOString(),
    scope: "machine",
    range: { preset: "7d", since: new Date(NOW_MS - 6 * 86_400_000).toISOString(), until: new Date(NOW_MS).toISOString() },
    summary: {
      totalTokens: 0,
      tokenTotalSource: "provider_logs",
      observedProviderTokens: 0,
      observedProviderInputTokens: 0,
      observedProviderOutputTokens: 0,
      observedProviderCachedTokens: 0,
      observedProviderCostRangeUsd: 0,
      observedProviderCost30dUsd: 0,
      observedProviderCostTodayUsd: 0,
      commitsCreated: 0,
      pushOperations: 0,
      prLandings: 0,
      prsTracked: 4,
      prsOpen: 1,
      prsMerged: 3,
      prsClosed: 0,
      prAdditions: 100,
      prDeletions: 20,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    },
    providers: [],
    models: [],
    daily: [
      { date: YESTERDAY, inputTokens: 0, outputTokens: 0, totalTokens: 0, commits: 0, prs: 0, insertions: 0, deletions: 0, filesChanged: 0, sessions: 0 },
      { date: TODAY, inputTokens: 0, outputTokens: 0, totalTokens: 0, commits: 0, prs: 0, insertions: 0, deletions: 0, filesChanged: 0, sessions: 0 },
    ],
    github: { repo: "acme/app", available: true, lastFetchedAt: null, error: null },
    ...overrides,
  };
}

function row(partial: Partial<AdeUsageRollupRow> & { date: string; provider: string }): AdeUsageRollupRow {
  return {
    model: "sonnet",
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
    ...partial,
  };
}

function makeRollup(
  machineKey: string,
  rows: AdeUsageRollupRow[],
  overrides: Partial<AdeUsageRollup> = {},
): AdeUsageRollup {
  return {
    version: 1,
    machineKey,
    label: machineKey,
    platform: "darwin",
    capturedAt: new Date(NOW_MS - 60_000).toISOString(),
    source: {
      sourceId: `source-${machineKey}`,
      roots: [`/users/dev/.claude`],
    },
    rows,
    ...overrides,
  };
}

function contribution(
  rollup: AdeUsageRollup | null,
  overrides: Partial<AccountUsageContribution> = {},
): AccountUsageContribution {
  return {
    machineKey: rollup?.machineKey ?? "unknown",
    label: rollup?.label ?? "unknown",
    platform: rollup?.platform ?? null,
    isLocal: false,
    origin: "rollup",
    rollup,
    ...overrides,
  };
}

describe("account usage merge", () => {
  it("adds a second machine's tokens, cost, providers, models and daily points into the totals", () => {
    const local = makeRollup("local", [
      row({ date: TODAY, provider: "claude", inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 1 }),
    ]);
    const remote = makeRollup("laptop", [
      row({ date: TODAY, provider: "claude", model: "opus", inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 3 }),
      row({ date: YESTERDAY, provider: "codex", model: "gpt", inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.5 }),
    ]);
    // The local machine's own numbers are already inside `localStats`; the merge
    // only folds the remote rollups on top of them.
    const localStats = makeStats();
    localStats.providers = [{
      provider: "claude",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      totalTokens: 150,
      rangeCostUsd: 1,
      todayCostUsd: 1,
      last30dCostUsd: 1,
    }];
    localStats.models = [{
      provider: "claude", model: "sonnet", calls: 0,
      inputTokens: 100, outputTokens: 50, cachedTokens: 0, totalTokens: 150, costUsd: 1,
    }];
    localStats.summary.observedProviderTokens = 150;
    localStats.summary.observedProviderInputTokens = 100;
    localStats.summary.observedProviderOutputTokens = 50;
    localStats.summary.observedProviderCostRangeUsd = 1;
    localStats.summary.totalTokens = 150;
    localStats.daily[1]!.inputTokens = 100;
    localStats.daily[1]!.outputTokens = 50;
    localStats.daily[1]!.totalTokens = 150;
    localStats.daily[1]!.byProvider = { claude: { totalTokens: 150, costUsd: 1 } };

    const merged = mergeAccountUsageStats({
      localStats,
      contributions: [
        contribution(local, { isLocal: true, origin: "live" }),
        contribution(remote),
      ],
      nowMs: NOW_MS,
    });

    expect(merged.scope).toBe("account");
    expect(merged.summary.observedProviderTokens).toBe(150 + 300 + 15);
    expect(merged.summary.observedProviderInputTokens).toBe(100 + 200 + 10);
    expect(merged.summary.observedProviderCostRangeUsd).toBeCloseTo(4.5, 5);
    expect(merged.summary.totalTokens).toBe(465);

    const claude = merged.providers.find((entry) => entry.provider === "claude");
    expect(claude?.totalTokens).toBe(450);
    expect(claude?.rangeCostUsd).toBeCloseTo(4, 5);
    const codex = merged.providers.find((entry) => entry.provider === "codex");
    expect(codex?.totalTokens).toBe(15);

    expect(merged.models.map((entry) => `${entry.provider}/${entry.model}`).sort())
      .toEqual(["claude/opus", "claude/sonnet", "codex/gpt"]);

    const today = merged.daily.find((point) => point.date === TODAY);
    expect(today?.totalTokens).toBe(450);
    const yesterday = merged.daily.find((point) => point.date === YESTERDAY);
    expect(yesterday?.totalTokens).toBe(15);

    expect(merged.machines?.map((machine) => [machine.machineKey, machine.state, machine.totalTokens]))
      .toEqual([["laptop", "rollup", 315], ["local", "live", 150]]);
  });

  it("keeps byProvider intact, merging a shared provider and introducing a new one", () => {
    const localStats = makeStats();
    localStats.daily[1]!.byProvider = { claude: { totalTokens: 150, costUsd: 1 } };
    const remote = makeRollup("laptop", [
      row({ date: TODAY, provider: "claude", totalTokens: 300, costUsd: 3 }),
      row({ date: TODAY, provider: "codex", model: "gpt", totalTokens: 40, costUsd: 0.25 }),
    ]);

    const merged = mergeAccountUsageStats({
      localStats,
      contributions: [contribution(remote)],
      nowMs: NOW_MS,
    });

    const today = merged.daily.find((point) => point.date === TODAY);
    expect(today?.byProvider).toEqual({
      claude: { totalTokens: 450, costUsd: 4 },
      codex: { totalTokens: 40, costUsd: 0.25 },
    });
  });

  it("rounds the per-day provider buckets with everything else", () => {
    // Provider, model and summary totals all get one rounding pass after the
    // fold. The daily buckets feed the stacked chart and its tooltip off the
    // same accumulation, so without the same pass the chart is the only surface
    // on the page carrying float drift.
    const localStats = makeStats();
    localStats.daily[1]!.byProvider = { claude: { totalTokens: 1, costUsd: 0.1 } };
    const remote = makeRollup("laptop", [
      row({ date: TODAY, provider: "claude", totalTokens: 1, costUsd: 0.2 }),
      row({ date: TODAY, provider: "codex", model: "gpt", totalTokens: 1, costUsd: 0.1 }),
      row({ date: TODAY, provider: "codex", model: "gpt-mini", totalTokens: 1, costUsd: 0.2 }),
    ]);

    const merged = mergeAccountUsageStats({
      localStats,
      contributions: [contribution(remote)],
      nowMs: NOW_MS,
    });

    const today = merged.daily.find((point) => point.date === TODAY);
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE 754, on both buckets.
    expect(today?.byProvider?.claude?.costUsd).toBe(0.3);
    expect(today?.byProvider?.codex?.costUsd).toBe(0.3);
  });

  it("lists a machine that failed to report and leaves it out of the totals", () => {
    const merged = mergeAccountUsageStats({
      localStats: makeStats(),
      contributions: [
        contribution(makeRollup("local", [row({ date: TODAY, provider: "claude", totalTokens: 10, costUsd: 1 })]), {
          isLocal: true,
          origin: "live",
        }),
        contribution(null, { machineKey: "studio", label: "Studio", platform: "win32", message: "Couldn't reach Studio" }),
      ],
      nowMs: NOW_MS,
    });

    const failed = merged.machines?.find((machine) => machine.machineKey === "studio");
    expect(failed?.state).toBe("failed");
    expect(failed?.totalTokens).toBe(0);
    expect(failed?.message).toBe("Couldn't reach Studio");
    expect(merged.summary.observedProviderTokens).toBe(0);
    expect(merged.sourceNotes?.some((note) => note.includes("didn't report"))).toBe(true);
    // The page still renders — a failure is a row, never a thrown error.
    expect(merged.daily.length).toBe(2);
  });

  it("still counts a stale machine but flags how old its numbers are", () => {
    const stale = makeRollup("shed", [row({ date: TODAY, provider: "claude", totalTokens: 500, costUsd: 5 })], {
      capturedAt: new Date(NOW_MS - ACCOUNT_ROLLUP_STALE_AFTER_MS - 60_000).toISOString(),
      source: { sourceId: "source-shed", roots: ["/users/other/.claude"] },
    });

    const merged = mergeAccountUsageStats({
      localStats: makeStats(),
      contributions: [contribution(stale)],
      nowMs: NOW_MS,
    });

    const machine = merged.machines?.find((entry) => entry.machineKey === "shed");
    expect(machine?.state).toBe("stale");
    expect(machine?.totalTokens).toBe(500);
    expect(merged.summary.observedProviderTokens).toBe(500);
  });

  it("counts a shared transcript directory once and names what it deduped against", () => {
    const rows = [
      row({ date: YESTERDAY, provider: "claude", totalTokens: 900, costUsd: 9 }),
    ];
    const sharedSource = {
      sourceId: "shared-home-marker",
      roots: ["/users/dev/.claude"],
    };
    const localStats = makeStats();
    const merged = mergeAccountUsageStats({
      localStats,
      contributions: [
        contribution(makeRollup("desk", rows, { label: "Desk", source: sharedSource }), {
          isLocal: true,
          origin: "live",
        }),
        contribution(makeRollup("vm", rows, { label: "VM", source: { ...sharedSource } })),
      ],
      nowMs: NOW_MS,
    });

    const vm = merged.machines?.find((entry) => entry.machineKey === "vm");
    expect(vm?.state).toBe("deduped");
    expect(vm?.dedupedAgainstMachineKey).toBe("desk");
    expect(vm?.totalTokens).toBe(0);
    // The shared 900 tokens are already inside the local stats and were counted
    // exactly once — the VM added nothing.
    expect(merged.summary.observedProviderTokens).toBe(0);
    expect(merged.sourceNotes?.some((note) => note.includes("share transcripts"))).toBe(true);
  });

  it("dedupes a marked machine against a markerless one in either processing order", () => {
    // One of the two could not read the marker this round — EACCES on the
    // share, or a capture from before the marker was first written — so it
    // carries no sourceId and gets no `bySourceId` entry. The marked peer must
    // still find it, whichever of the two is processed first, or the machine
    // oscillates between deduped and counted between refreshes.
    const rows = [row({ date: YESTERDAY, provider: "claude", totalTokens: 900, costUsd: 9 })];
    const roots = [transcriptRootDigest("/users/dev/.claude")];
    const marked = makeRollup("desk", rows, {
      label: "Desk",
      source: { sourceId: "shared-home-marker", roots },
    });
    const markerless = makeRollup("vm", rows, {
      label: "VM",
      source: { sourceId: null, roots },
    });
    const bounds = { since: new Date(NOW_MS - 6 * 86_400_000).toISOString(), until: new Date(NOW_MS).toISOString() };

    const dedupedIn = (localRollup: AdeUsageRollup, peer: AdeUsageRollup): string[] => {
      const { machines } = resolveContributions(
        [contribution(localRollup, { isLocal: true, origin: "live" }), contribution(peer)],
        bounds,
        NOW_MS,
      );
      return machines.filter((entry) => entry.state === "deduped").map((entry) => entry.machineKey);
    };

    // Markerless first is the order that used to double the totals.
    expect(dedupedIn(markerless, marked)).toEqual(["desk"]);
    expect(dedupedIn(marked, markerless)).toEqual(["vm"]);
  });

  it("merges two machines cloned from one disk image, and says so on the machine list", () => {
    // The accepted trade of marker-only dedupe. A disk image copies
    // `.ade-usage-source`, so a restored clone carries the marker of the
    // machine it was imaged from and merges into it — the account under-counts
    // rather than silently doubling, and the machine list is where that shows.
    const deskRows = [row({ date: YESTERDAY, provider: "claude", totalTokens: 900, costUsd: 9 })];
    const cloneRows = [row({ date: YESTERDAY, provider: "claude", totalTokens: 100, costUsd: 1 })];
    const source = { sourceId: "imaged-marker", roots: [transcriptRootDigest("/users/dev/.claude")] };
    const merged = mergeAccountUsageStats({
      localStats: makeStats(),
      contributions: [
        contribution(makeRollup("desk", deskRows, { label: "Desk", source }), {
          isLocal: true,
          origin: "live",
        }),
        contribution(makeRollup("clone", cloneRows, { label: "Clone", source: { ...source } })),
      ],
      nowMs: NOW_MS,
    });

    const clone = merged.machines?.find((entry) => entry.machineKey === "clone");
    expect(clone?.state).toBe("deduped");
    expect(clone?.dedupedAgainstMachineKey).toBe("desk");
    expect(clone?.message).toContain("Desk");
    expect(clone?.totalTokens).toBe(0);
    expect(merged.summary.observedProviderTokens).toBe(0);
  });

  it("rounds folded cost once instead of once per row", () => {
    // 300 rows at a third of a cent each. Rounding inside the loop drives every
    // one of them to zero; rounding once after the fold reports the dollar.
    const rows = Array.from({ length: 300 }, (_, index) => row({
      date: index % 2 === 0 ? TODAY : YESTERDAY,
      provider: "claude",
      model: `model-${index % 3}`,
      totalTokens: 1,
      costUsd: 0.0033,
    }));
    const merged = mergeAccountUsageStats({
      localStats: makeStats(),
      contributions: [contribution(makeRollup("laptop", rows))],
      nowMs: NOW_MS,
    });
    expect(merged.summary.observedProviderCostRangeUsd).toBeCloseTo(0.99, 5);
    const claude = merged.providers.find((entry) => entry.provider === "claude");
    expect(claude?.rangeCostUsd).toBeCloseTo(0.99, 5);
    const modelCost = merged.models.reduce((total, entry) => total + entry.costUsd, 0);
    expect(modelCost).toBeCloseTo(0.99, 2);
  });

  it("does not merge GitHub or PR metrics across machines", () => {
    const merged = mergeAccountUsageStats({
      localStats: makeStats(),
      contributions: [
        contribution(makeRollup("a", [row({ date: TODAY, provider: "claude", totalTokens: 1 })]), { isLocal: true, origin: "live" }),
        contribution(makeRollup("b", [row({ date: TODAY, provider: "claude", totalTokens: 1 })], {
          source: { sourceId: "source-b", roots: ["/b"] },
        })),
      ],
      nowMs: NOW_MS,
    });

    expect(merged.summary.prsTracked).toBe(4);
    expect(merged.summary.prsMerged).toBe(3);
    expect(merged.summary.prAdditions).toBe(100);
    expect(merged.sourceNotes?.some((note) => note.includes("this computer only"))).toBe(true);
  });

  it("ignores rollup rows outside the requested range", () => {
    const old = localDayKey(NOW_MS - 30 * 86_400_000);
    const merged = mergeAccountUsageStats({
      localStats: makeStats(),
      contributions: [contribution(makeRollup("laptop", [
        row({ date: old, provider: "claude", totalTokens: 10_000, costUsd: 100 }),
        row({ date: TODAY, provider: "claude", totalTokens: 7, costUsd: 1 }),
      ]))],
      nowMs: NOW_MS,
    });

    expect(merged.summary.observedProviderTokens).toBe(7);
  });
});

describe("transcript source identity", () => {
  function memoryFs(files: Record<string, string>): UsageSourceFsApi {
    return {
      readFileSync: (file) => {
        const value = files[file];
        if (value == null) throw new Error("ENOENT");
        return value;
      },
      writeFileSync: (file, data) => {
        files[file] = data;
      },
      mkdirSync: () => undefined,
      renameSync: (from, to) => {
        const value = files[from];
        if (value == null) throw new Error("ENOENT");
        delete files[from];
        files[to] = value;
      },
      rmSync: (file) => {
        delete files[file];
      },
    };
  }

  it("writes the marker through a temp file and leaves nothing behind", () => {
    const files: Record<string, string> = {};
    const id = readOrCreateUsageSourceId("/mnt/home", memoryFs(files), () => "marker-atomic");
    expect(id).toBe("marker-atomic");
    // Exactly one file, at the final name: a reader on a shared mount never
    // sees a half-written marker, and no `.tmp` file is orphaned.
    expect(Object.keys(files)).toEqual(["/mnt/home/.ade-usage-source"]);
  });

  it("returns the id already on disk when another machine won the create race", () => {
    const files: Record<string, string> = {};
    const io = memoryFs(files);
    const racing: UsageSourceFsApi = {
      ...io,
      renameSync: (from, to) => {
        // A machine on the same mount renamed its own marker in first.
        files[to] = "winner-marker\n";
        delete files[from];
      },
    };
    expect(readOrCreateUsageSourceId("/mnt/home", racing, () => "loser-marker"))
      .toBe("winner-marker");
  });

  it("reads the same marker id from a shared home, and mints distinct ids otherwise", () => {
    const shared: Record<string, string> = {};
    const sharedIo = memoryFs(shared);
    const first = readOrCreateUsageSourceId("/mnt/home", sharedIo, () => "marker-1");
    const second = readOrCreateUsageSourceId("/mnt/home", sharedIo, () => "marker-2");
    expect(first).toBe("marker-1");
    expect(second).toBe("marker-1");

    const separate = readOrCreateUsageSourceId("/other/home", memoryFs({}), () => "marker-3");
    expect(separate).toBe("marker-3");
  });

  it("degrades to null rather than throwing when the marker cannot be written", () => {
    const readOnly: UsageSourceFsApi = {
      readFileSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: () => {
        throw new Error("EROFS");
      },
      mkdirSync: () => undefined,
    };
    expect(readOrCreateUsageSourceId("/ro/home", readOnly)).toBeNull();
  });

  it("normalizes Windows roots so separator style and case never split one source in two", () => {
    const io = memoryFs({});
    const a = buildTranscriptSource({
      roots: ["C:\\Users\\Dev\\.claude", "C:/Users/Dev/.codex"],
      home: "C:\\Users\\Dev",
      platform: "win32",
      io,
    });
    const b = buildTranscriptSource({
      roots: ["c:/users/dev/.codex\\", "\\\\?\\C:\\Users\\Dev\\.claude"],
      home: "C:\\Users\\Dev",
      platform: "win32",
      io,
    });
    // The fold happens before the hash, or the two spellings would stop
    // matching. The paths themselves never leave the machine.
    expect(a.roots).toEqual([
      transcriptRootDigest("c:\\users\\dev\\.claude"),
      transcriptRootDigest("c:\\users\\dev\\.codex"),
    ]);
    expect(a.roots).toEqual(b.roots);
    expect(isSameTranscriptSource({ ...a, sourceId: null }, { ...b, sourceId: null })).toBe(true);
  });

  it("never ships an absolute transcript path off the machine", () => {
    const source = buildTranscriptSource({
      roots: ["/Users/alice/.claude", "/Users/alice/.codex"],
      home: "/Users/alice",
      platform: "darwin",
      io: memoryFs({}),
    });
    const serialized = JSON.stringify(source);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("/Users");
    expect(serialized).not.toContain(".claude");
    for (const root of source.roots) expect(root).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps case-distinct Linux roots apart", () => {
    const io = memoryFs({});
    const lower = buildTranscriptSource({ roots: ["/home/dev/.claude"], home: "/home/dev", platform: "linux", io });
    const upper = buildTranscriptSource({ roots: ["/home/Dev/.claude"], home: "/home/dev", platform: "linux", io });
    expect(isSameTranscriptSource({ ...lower, sourceId: null }, { ...upper, sourceId: null })).toBe(false);
  });

  it("matches two markerless machines on their folded roots alone", () => {
    // The degraded path: neither side could read or write the marker (a
    // read-only mount, a locked-down profile), so the digested roots are the
    // only signal left.
    const shared = { sourceId: null, roots: [transcriptRootDigest("/home/dev/.claude")] };
    expect(isSameTranscriptSource(shared, { ...shared })).toBe(true);
    expect(isSameTranscriptSource(shared, {
      sourceId: null,
      roots: [transcriptRootDigest("/home/other/.claude")],
    })).toBe(false);
  });

  it("never matches a machine with no roots at all", () => {
    // "Nothing to compare" is not agreement: an empty root list would otherwise
    // dedupe every markerless machine into the first one.
    const empty = { sourceId: null, roots: [] };
    expect(isSameTranscriptSource(empty, { ...empty })).toBe(false);
    expect(isSameTranscriptSource(empty, { sourceId: null, roots: ["abc"] })).toBe(false);
  });

  it("trusts the marker over the paths when both machines have one", () => {
    // Same username, same default path, genuinely different machines.
    const a = { sourceId: "machine-a", roots: [transcriptRootDigest("/users/dev/.claude")] };
    const b = { sourceId: "machine-b", roots: [transcriptRootDigest("/users/dev/.claude")] };
    expect(isSameTranscriptSource(a, b)).toBe(false);
  });

  it("treats a matching marker as the whole answer, whatever the roots say", () => {
    // The mount point is not part of the question: one share mounted at
    // different paths on two machines is still one directory. Equal markers end
    // the comparison in both directions.
    const io = memoryFs({});
    const here = buildTranscriptSource({ roots: ["/mnt/home/.claude"], home: "/mnt/home", io });
    const there = buildTranscriptSource({ roots: ["/net/dev/.claude"], home: "/mnt/home", io });
    expect(here.sourceId).toBe(there.sourceId);
    expect(here.roots).not.toEqual(there.roots);
    expect(isSameTranscriptSource(here, there)).toBe(true);
  });

});

describe("account scope through the usage service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Move wall-clock time forward without touching timers.
   *
   * The live refresh is rate-limited per cache key, which is the point of one
   * of the tests below — but the *other* tests need a second refresh to
   * actually run, and sleeping thirty real seconds is not a test.
   */
  function advanceableClock() {
    const real = Date.now;
    let offsetMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => real() + offsetMs);
    return { advance: (ms: number) => { offsetMs += ms; } };
  }

  /** Let every already-scheduled background task and its update land. */
  async function quiesce() {
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function createLogger() {
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as Parameters<typeof createUsageTrackingService>[0]["logger"];
  }

  function createStubStore(rollups: AdeUsageRollup[]) {
    const stored = new Map(rollups.map((rollup) => [rollup.machineKey, rollup]));
    return {
      publish: (rollup: AdeUsageRollup) => {
        stored.set(rollup.machineKey, rollup);
        return true;
      },
      readAll: () => [...stored.values()],
      prune: () => undefined,
      stored,
    };
  }

  function createService(
    store: ReturnType<typeof createStubStore> | { publish: (rollup: AdeUsageRollup) => boolean; readAll: () => AdeUsageRollup[]; prune: () => void },
    extra: Record<string, unknown> = {},
    options: { onUpdate?: () => void } = {},
  ) {
    return createUsageTrackingService({
      logger: createLogger(),
      ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
      dependencies: {
        pollClaudeUsage: async () => ({ windows: [], extraUsage: null, errors: [] }),
        pollCodexUsage: async () => ({ windows: [], errors: [] }),
        scanClaudeLogs: async () => [],
        scanCodexLogs: async () => [],
        scanCursorLogs: async () => [],
        scanCursorAgentLogs: async () => [],
        scanOpenClawLogs: async () => [],
        scanOpenCodeLogs: async () => [],
        scanDroidLogs: async () => [],
        scanCopilotLogs: async () => [],
        scanGeminiLogs: async () => [],
        collectDatabaseStats: () => null,
        scanGitHubStats: async () => ({
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
        }),
        accountRollupStore: store,
        localMachineIdentity: () => ({ machineKey: "this-machine", label: "Desk", platform: "darwin" }),
        transcriptRoots: () => ["/users/dev/.claude"],
        transcriptHome: "/users/dev",
        transcriptSourceFs: {
          readFileSync: () => "desk-marker-id",
          writeFileSync: () => undefined,
          mkdirSync: () => undefined,
        },
        ...extra,
      },
    } as Parameters<typeof createUsageTrackingService>[0]);
  }

  it("reports the scope the reader asked for, once per read, with nothing else attached", async () => {
    // The durable owner boundary for "which usage scope does this installation
    // actually use". The service emits one capture per read and leaves the
    // per-scope daily suppression to the analytics service's dedupe key, so the
    // only thing to prove here is the payload and that the scope is honest.
    const captured: Array<Record<string, unknown>> = [];
    const service = createService(createStubStore([]), {
      captureAnalytics: (input: Record<string, unknown>) => { captured.push(input); },
    });
    try {
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await service.getAdeUsageStats({ preset: "30d", scope: "machine" });
      // An unknown scope is normalized before it is reported, so a bad caller
      // can never put a free-text value on the capture.
      await service.getAdeUsageStats({ preset: "7d", scope: "everything" as never });

      expect(captured.map((entry) => (entry.properties as Record<string, unknown>).outcome))
        .toEqual(["account", "machine", "machine"]);
      expect(captured.map((entry) => entry.dedupeKey))
        .toEqual(["usage_scope:account", "usage_scope:machine", "usage_scope:machine"]);
      for (const entry of captured) {
        expect(entry.event).toBe("ade_feature_used");
        expect(entry.minimumIntervalMs).toBe(24 * 60 * 60 * 1_000);
        expect(entry.projectId).toBeNull();
        expect(Object.keys(entry.properties as Record<string, unknown>).sort())
          .toEqual(["action", "feature", "outcome"]);
      }
    } finally {
      service.dispose();
    }
  });

  it("serves the page even when the analytics sink throws", async () => {
    const service = createService(createStubStore([]), {
      captureAnalytics: () => { throw new Error("analytics state file is locked"); },
    });
    try {
      const stats = await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      expect(stats.scope).toBe("account");
      expect(stats.machines?.map((machine) => machine.machineKey)).toEqual(["this-machine"]);
    } finally {
      service.dispose();
    }
  });

  it("resolves the transcript marker once per ledger scan, not once per page read", async () => {
    // `buildLocalRollup` runs on every account-scoped read, and the marker it
    // needs lives in a dot file in the transcript home — so an uncached
    // `buildTranscriptSource` puts filesystem I/O on every render of the Usage
    // page. The marker only moves when a scan does, which is where it is
    // invalidated.
    let markerReads = 0;
    const service = createService(createStubStore([]), {
      transcriptSourceFs: {
        readFileSync: () => {
          markerReads += 1;
          return "desk-marker-id";
        },
        writeFileSync: () => undefined,
        mkdirSync: () => undefined,
      },
    });
    try {
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      // Let the background ledger scan — the one place the cache is dropped —
      // finish, so what follows measures reads and nothing else.
      await quiesce();
      const afterScan = markerReads;
      expect(afterScan).toBeGreaterThan(0);

      await service.getAdeUsageStats({ preset: "30d", scope: "account" });
      await service.getAdeUsageStats({ preset: "today", scope: "account" });
      expect(markerReads).toBe(afterScan);

      // The cached source is still exactly what an uncached build produces.
      expect(service.getUsageRollup()?.source.sourceId).toBe("desk-marker-id");
    } finally {
      service.dispose();
    }
  });

  it("reports account scope with every stored machine, including one that never reported", async () => {
    const store = createStubStore([
      makeRollup("laptop", [row({ date: TODAY, provider: "claude", inputTokens: 60, outputTokens: 40, totalTokens: 100, costUsd: 2 })], {
        label: "Laptop",
        source: { sourceId: "laptop-marker", roots: ["/users/dev/.claude"] },
      }),
    ]);
    const service = createService(store);
    try {
      const stats = await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      expect(stats.scope).toBe("account");
      const keys = stats.machines?.map((machine) => machine.machineKey).sort();
      expect(keys).toEqual(["laptop", "this-machine"]);
      expect(stats.summary.observedProviderTokens).toBe(100);
      // Machine scope must be untouched by any of this.
      const machineScoped = await service.getAdeUsageStats({ preset: "7d", scope: "machine" });
      expect(machineScoped.machines).toBeUndefined();
      expect(machineScoped.summary.observedProviderTokens).toBe(0);
    } finally {
      service.dispose();
    }
  });

  it("renders immediately when the live refresh cannot reach anyone", async () => {
    const store = createStubStore([
      makeRollup("laptop", [row({ date: TODAY, provider: "claude", totalTokens: 5, costUsd: 1 })], {
        source: { sourceId: "laptop-marker", roots: ["/x"] },
      }),
    ]);
    const service = createService(store);
    let settled = false;
    service.setAccountRollupFetcher(async () => {
      // A machine that is asleep behind a relay: this hangs past the page load.
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = true;
      throw new Error("unreachable");
    });
    try {
      const stats = await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      // The page did not wait for it.
      expect(settled).toBe(false);
      expect(stats.machines?.length).toBe(2);
      expect(stats.summary.observedProviderTokens).toBe(5);
    } finally {
      service.dispose();
    }
  });

  it("lists a machine the live refresh could not reach and that never published", async () => {
    const store = createStubStore([]);
    const service = createService(store);
    service.setAccountRollupFetcher(async () => ({
      rollups: [],
      failures: [{
        machineKey: "laptop",
        label: "Laptop",
        platform: "darwin",
        message: "Couldn't reach this computer",
      }],
    }));
    try {
      // First read starts the background refresh; it is deliberately not awaited.
      const first = await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      expect(first.machines?.map((machine) => machine.machineKey)).toEqual(["this-machine"]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const stats = await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      const laptop = stats.machines?.find((machine) => machine.machineKey === "laptop");
      expect(laptop?.state).toBe("failed");
      expect(laptop?.label).toBe("Laptop");
      expect(laptop?.message).toBe("Couldn't reach this computer");
      expect(laptop?.totalTokens).toBe(0);
      expect(stats.sourceNotes).toContain("1 computer didn't report — not in these totals.");
    } finally {
      service.dispose();
    }
  });

  it("prefers a machine's stored rollup over a live-refresh failure", async () => {
    const store = createStubStore([
      makeRollup("laptop", [row({ date: TODAY, provider: "claude", totalTokens: 7, costUsd: 1 })], {
        label: "Laptop",
        source: { sourceId: "laptop-marker", roots: ["/x"] },
      }),
    ]);
    const service = createService(store);
    service.setAccountRollupFetcher(async () => ({
      rollups: [],
      failures: [{
        machineKey: "laptop",
        label: "Laptop",
        platform: "darwin",
        message: "Couldn't reach this computer",
      }],
    }));
    try {
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const stats = await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      const laptop = stats.machines?.find((machine) => machine.machineKey === "laptop");
      expect(laptop?.state).not.toBe("failed");
      expect(laptop?.totalTokens).toBe(7);
      expect(stats.machines?.length).toBe(2);
    } finally {
      service.dispose();
    }
  });

  it("does not fan out again on the read its own refresh causes", async () => {
    // Account scope closes a loop by construction: the read starts a refresh,
    // the refresh emits an update, every subscriber re-reads, and that read is
    // another account-scoped read. The in-flight map only collapses concurrent
    // calls — it is cleared before the follow-up read arrives — so without a
    // minimum interval the page fans out to every machine on the account for as
    // long as it is open.
    const store = createStubStore([]);
    let fanOuts = 0;
    const service = createService(store);
    service.setAccountRollupFetcher(async () => {
      fanOuts += 1;
      return { rollups: [], failures: [] };
    });
    try {
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fanOuts).toBe(1);

      // Exactly what the renderer does when the refresh emits its update.
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fanOuts).toBe(1);
    } finally {
      service.dispose();
    }
  });

  it("does not fan out once per range preset, and lets an explicit refresh through", async () => {
    // `fetchAccountRollups` takes no range: every machine is asked for its whole
    // rollup whatever the reader is looking at. A floor keyed by range therefore
    // charged one fan-out per preset — walking day → week → month → year → all
    // fired five, to up to twelve machines each — while silently suppressing the
    // one call that is not part of the read → refresh → emit → read loop: the
    // user pressing Refresh, which always lands inside the floor because the
    // page read on mount.
    const store = createStubStore([]);
    let fanOuts = 0;
    const service = createService(store);
    service.setAccountRollupFetcher(async () => {
      fanOuts += 1;
      return { rollups: [], failures: [] };
    });
    try {
      await service.getAdeUsageStats({ preset: "today", scope: "account" });
      await quiesce();
      expect(fanOuts).toBe(1);

      for (const preset of ["7d", "30d", "year", "all"] as const) {
        await service.getAdeUsageStats({ preset, scope: "account" });
        await quiesce();
      }
      expect(fanOuts).toBe(1);

      // The Refresh button, well inside the 30s floor.
      await service.getAdeUsageStats({ preset: "7d", scope: "account", force: true });
      await quiesce();
      expect(fanOuts).toBe(2);

      // And it does not disarm the floor for the reads its own update causes.
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await quiesce();
      expect(fanOuts).toBe(2);
    } finally {
      service.dispose();
    }
  });

  it("collapses two forced refreshes that overlap into one fan-out", async () => {
    // `force` bypasses the floor, not the in-flight collapse: pressing Refresh
    // twice must not put two fan-outs on the network.
    const store = createStubStore([]);
    let fanOuts = 0;
    let release = (): void => {};
    const service = createService(store);
    service.setAccountRollupFetcher(async () => {
      fanOuts += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { rollups: [], failures: [] };
    });
    try {
      await service.getAdeUsageStats({ preset: "7d", scope: "account", force: true });
      await service.getAdeUsageStats({ preset: "7d", scope: "account", force: true });
      await quiesce();
      expect(fanOuts).toBe(1);
    } finally {
      release();
      await quiesce();
      service.dispose();
    }
  });

  it("emits no usage update when the refresh stored nothing new", async () => {
    const laptop = makeRollup("laptop", [row({ date: TODAY, provider: "claude", totalTokens: 5, costUsd: 1 })]);
    let published: AdeUsageRollup[] = [];
    // A store that reports honestly: the same rollup twice is not a change.
    const stored = new Map<string, string>();
    const store = {
      publish: (rollup: AdeUsageRollup) => {
        const serialized = JSON.stringify(rollup);
        if (stored.get(rollup.machineKey) === serialized) return false;
        stored.set(rollup.machineKey, serialized);
        return true;
      },
      readAll: () => [laptop],
      prune: () => undefined,
    };
    let updates = 0;
    const clock = advanceableClock();
    const service = createService(store, {}, { onUpdate: () => { updates += 1; } });
    service.setAccountRollupFetcher(async () => ({ rollups: published, failures: [] }));
    try {
      // Warm-up: let the first ledger scan and its own updates settle, so what
      // is measured below is only the account refresh.
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await quiesce();

      // Genuinely new history: the page must be told.
      published = [laptop];
      clock.advance(60_000);
      const beforeNew = updates;
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await quiesce();
      expect(updates).toBeGreaterThan(beforeNew);

      // Same numbers again. "The insert did not throw" is not news, and an
      // update here is what makes the next read, which makes the next refresh.
      clock.advance(60_000);
      const beforeRepublish = updates;
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await quiesce();
      expect(updates).toBe(beforeRepublish);
    } finally {
      service.dispose();
    }
  });

  it("does not re-emit for a peer that fails identically every round", async () => {
    const store = createStubStore([]);
    let updates = 0;
    const clock = advanceableClock();
    const service = createService(store, {}, { onUpdate: () => { updates += 1; } });
    const failure = {
      machineKey: "laptop",
      label: "Laptop",
      platform: "darwin",
      message: "Couldn't reach this computer",
    };
    service.setAccountRollupFetcher(async () => ({ rollups: [], failures: [failure] }));
    try {
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await quiesce();

      // A permanently unreachable machine reports the same failure forever.
      // Reading that as a change would keep the page emitting news it already
      // showed — which is the other half of the same loop.
      clock.advance(60_000);
      const before = updates;
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await quiesce();
      expect(updates).toBe(before);

      // A failure that really did change still reaches the page.
      failure.message = "This computer's ADE is too old to share usage";
      clock.advance(60_000);
      await service.getAdeUsageStats({ preset: "7d", scope: "account" });
      await quiesce();
      expect(updates).toBeGreaterThan(before);
    } finally {
      service.dispose();
    }
  });

  it("answers null until the first ledger scan has completed", async () => {
    const store = createStubStore([]);
    const service = createService(store);
    try {
      // Nothing has scanned yet: an empty rollup here would be stored by the
      // caller as authoritative and would delete this machine's whole history.
      expect(service.getUsageRollup()).toBeNull();
      await service.refreshHistory({ reason: "user" });
      expect(service.getUsageRollup()).not.toBeNull();
    } finally {
      service.dispose();
    }
  });

  it("publishes only aggregates — no transcript record ever leaves the machine", async () => {
    const store = createStubStore([]);
    const service = createService(store);
    try {
      await service.refreshHistory({ reason: "user" });
      const rollup = service.getUsageRollup();
      if (!rollup) throw new Error("expected a rollup after the first scan");
      expect(rollup.machineKey).toBe("this-machine");
      expect(rollup.source.sourceId).toBe("desk-marker-id");
      const serialized = JSON.stringify(rollup);
      expect(serialized).not.toContain("sessionId");
      expect(serialized).not.toContain("cwd");
      for (const rollupRow of rollup.rows) {
        expect(Object.keys(rollupRow).sort()).toEqual([
          "cachedTokens", "calls", "costUsd", "date", "inputTokens",
          "model", "outputTokens", "provider", "totalTokens",
        ]);
      }
    } finally {
      service.dispose();
    }
  });

  describe("a scan that could not read everything", () => {
    /**
     * A provider whose scan threw, and one whose scan swallowed an unreadable
     * directory and returned the rest, are the same thing at two granularities:
     * rows that are missing because they could not be read, not because the
     * days went away. Reconciling stored history against that silence deletes
     * it — and because these are CRR tables, the deletes replicate to every
     * machine on the account.
     *
     * This drives the real service so the whole path is under test: scan result
     * → `skipReconcileProviders` → the store's delete-reconcile.
     */
    /** All nine off, so the service takes its worker-result path. */
    const NO_INJECTED_SCANNERS = {
      scanClaudeLogs: undefined,
      scanCodexLogs: undefined,
      scanCursorLogs: undefined,
      scanCursorAgentLogs: undefined,
      scanOpenClawLogs: undefined,
      scanOpenCodeLogs: undefined,
      scanDroidLogs: undefined,
      scanCopilotLogs: undefined,
      scanGeminiLogs: undefined,
    };

    function claudeScan({ tokens, incompleteProviders }: { tokens: number; incompleteProviders: string[] }) {
      const costs: CostSnapshot[] = tokens > 0
        ? [{
          provider: "claude",
          last30dCostUsd: 0,
          todayCostUsd: 0,
          tokenBreakdown: {},
          dailyTokenBreakdownByPreset: { all: { [YESTERDAY]: { opus: { input: tokens, output: 0, cached: 0 } } } },
        }]
        : [];
      return async () => ({
        costs,
        projectCosts: [],
        daily7d: {},
        entryCounts: { claude: tokens > 0 ? 1 : 0 },
        providerErrors: {},
        incompleteProviders,
      });
    }

    it("keeps an incomplete provider's stored history out of the delete-reconcile", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
      // Same reasoning as a failed provider: the rows are missing because they
      // were unreadable, not because the days went away.
      const skipped: string[][] = [];
      const store = {
        publish: (_rollup: AdeUsageRollup, options?: { skipReconcileProviders?: readonly string[] | ReadonlySet<string> }) => {
          skipped.push([...(options?.skipReconcileProviders ?? [])]);
          return true;
        },
        readAll: () => [],
        prune: () => undefined,
      };
      const service = createService(store, {
        ...NO_INJECTED_SCANNERS,
        scanUsageLedgers: claudeScan({ tokens: 0, incompleteProviders: ["claude"] }),
      });
      try {
        await service.refreshHistory({ reason: "user" });
        expect(skipped.at(-1)).toContain("claude");
      } finally {
        service.dispose();
      }
    });

    // Keeping the stored rows only stops a *deletion*. The in-memory cost cache
    // is what the page reads, what the rollup is built from, and what gets
    // persisted across restarts — so overwriting it with a partial round's
    // subset silently lowered a complete provider's totals, and permanently,
    // because the moved cost-cache timestamp also disarmed the retry.
    it("carries a partial provider's last complete snapshot forward instead of lowering its totals", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
      const published: AdeUsageRollup[] = [];
      const store = {
        publish: (rollup: AdeUsageRollup) => {
          published.push(rollup);
          return true;
        },
        readAll: () => [],
        prune: () => undefined,
      };
      let scan = claudeScan({ tokens: 1_000, incompleteProviders: [] });
      const service = createService(store, {
        ...NO_INJECTED_SCANNERS,
        scanUsageLedgers: () => scan(),
      });
      const totalTokens = (rollup: AdeUsageRollup | null) =>
        (rollup?.rows ?? []).reduce((sum, row) => sum + row.totalTokens, 0);
      try {
        await service.refreshHistory({ reason: "user" });
        expect(totalTokens(published.at(-1)!)).toBe(1_000);

        // Same provider, this time unreadable: it reports nothing and is named
        // incomplete. Its numbers must not move.
        scan = claudeScan({ tokens: 0, incompleteProviders: ["claude"] });
        await service.refreshHistory({ reason: "user" });
        expect(totalTokens(published.at(-1)!)).toBe(1_000);
        expect(totalTokens(service.getUsageRollup())).toBe(1_000);

        // And the page says so, rather than showing a quietly unchanged number.
        const stats = await service.getAdeUsageStats({ preset: "all", scope: "machine" });
        expect(stats.sourceNotes?.some((note) => note.includes("Couldn't read all of Claude"))).toBe(true);
      } finally {
        service.dispose();
      }
    });

    // The carry-forward originally only fired when a provider produced
    // *nothing*. A scan that hits a read error part-way through still returns
    // the entries it reached, so a partial round produced snapshots, carried
    // nothing, and left the page fully populated with no note at all — one
    // unreadable file inside the transcripts silently lowered the totals and
    // moved the cache timestamp forward, disarming the retry.
    it("neither lowers the totals nor stays silent when a partial round still produces entries", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
      const published: AdeUsageRollup[] = [];
      const store = {
        publish: (rollup: AdeUsageRollup) => {
          published.push(rollup);
          return true;
        },
        readAll: () => [],
        prune: () => undefined,
      };
      let scan = claudeScan({ tokens: 1_000, incompleteProviders: [] });
      const service = createService(store, {
        ...NO_INJECTED_SCANNERS,
        scanUsageLedgers: () => scan(),
      });
      const totalTokens = (rollup: AdeUsageRollup | null) =>
        (rollup?.rows ?? []).reduce((sum, row) => sum + row.totalTokens, 0);
      try {
        await service.refreshHistory({ reason: "user" });
        expect(totalTokens(published.at(-1)!)).toBe(1_000);

        // Partial, not empty: 400 of the 1,000 tokens were readable.
        scan = claudeScan({ tokens: 400, incompleteProviders: ["claude"] });
        await service.refreshHistory({ reason: "user" });
        expect(totalTokens(published.at(-1)!)).toBe(1_000);
        expect(totalTokens(service.getUsageRollup())).toBe(1_000);

        const stats = await service.getAdeUsageStats({ preset: "all", scope: "machine" });
        expect(stats.sourceNotes?.some((note) => note.includes("Couldn't read all of Claude"))).toBe(true);
      } finally {
        service.dispose();
      }
    });

    // The larger of the two rounds wins, so real new usage still lands even
    // while a provider is flagged incomplete.
    it("keeps the newer numbers when an incomplete round is still the larger one", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
      const published: AdeUsageRollup[] = [];
      const store = {
        publish: (rollup: AdeUsageRollup) => {
          published.push(rollup);
          return true;
        },
        readAll: () => [],
        prune: () => undefined,
      };
      let scan = claudeScan({ tokens: 1_000, incompleteProviders: [] });
      const service = createService(store, {
        ...NO_INJECTED_SCANNERS,
        scanUsageLedgers: () => scan(),
      });
      const totalTokens = (rollup: AdeUsageRollup | null) =>
        (rollup?.rows ?? []).reduce((sum, row) => sum + row.totalTokens, 0);
      try {
        await service.refreshHistory({ reason: "user" });
        scan = claudeScan({ tokens: 2_500, incompleteProviders: ["claude"] });
        await service.refreshHistory({ reason: "user" });

        expect(totalTokens(published.at(-1)!)).toBe(2_500);
        // Still said out loud: the round was not a complete read.
        const stats = await service.getAdeUsageStats({ preset: "all", scope: "machine" });
        expect(stats.sourceNotes?.some((note) => note.includes("Couldn't read all of Claude"))).toBe(true);
      } finally {
        service.dispose();
      }
    });
  });

  describe("machine identity", () => {
    /**
     * `localMachineIdentity.ts` states the invariant: publishing under any key
     * other than the account directory's is a second, phantom computer that no
     * peer reconciles with the real one — replicated account-wide, cleaned up by
     * nothing. A hostname fallback for an unreadable identity was exactly that,
     * so an unresolvable identity is a skipped publish and a retryable null.
     */
    it("publishes nothing and reports no rollup while its identity is unresolvable", async () => {
      const published: AdeUsageRollup[] = [];
      const store = {
        publish: (rollup: AdeUsageRollup) => {
          published.push(rollup);
          return true;
        },
        readAll: () => [],
        prune: () => undefined,
      };
      const service = createService(store, { localMachineIdentity: () => null });
      try {
        await service.refreshHistory({ reason: "user" });
        expect(published).toEqual([]);
        expect(service.getUsageRollup()).toBeNull();

        // The page still lists this computer — honestly, as one that did not
        // report — instead of dropping it out of the totals in silence.
        const stats = await service.getAdeUsageStats({ preset: "7d", scope: "account" });
        expect(stats.machines?.length).toBe(1);
        expect(stats.machines?.[0].machineKey).not.toBe("this-machine");
      } finally {
        service.dispose();
      }
    });
  });
});

describe("rollup construction", () => {
  it("projects per-model daily cost snapshots into day x provider x model rows", () => {
    const costs: CostSnapshot[] = [{
      provider: "claude",
      last30dCostUsd: 4,
      todayCostUsd: 1,
      tokenBreakdown: {},
      dailyTokenBreakdownByPreset: {
        all: {
          [TODAY]: { sonnet: { input: 10, output: 5, cached: 2, cacheWrite: 1, costUsd: 0.5 } },
          [YESTERDAY]: { opus: { input: 1, output: 1, cached: 0, costUsd: 0.25 } },
        },
      },
    }];
    expect(buildRollupRows(costs)).toEqual([
      { date: TODAY, provider: "claude", model: "sonnet", inputTokens: 10, outputTokens: 5, cachedTokens: 3, totalTokens: 18, costUsd: 0.5, calls: 0 },
      { date: YESTERDAY, provider: "claude", model: "opus", inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2, costUsd: 0.25, calls: 0 },
    ]);
  });

  it("falls back to flat daily totals for hosts with no per-model breakdown", () => {
    const costs: CostSnapshot[] = [{
      provider: "codex",
      last30dCostUsd: 0,
      todayCostUsd: 0,
      tokenBreakdown: {},
      dailyTokensByPreset: { all: { [TODAY]: 42 } },
    }];
    expect(buildRollupRows(costs)).toEqual([
      { date: TODAY, provider: "codex", model: "unknown", inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 42, costUsd: 0, calls: 0 },
    ]);
  });

  it("bounds the archive at the retention edge it will be pruned to", () => {
    // The `all` preset spans ten years; the store keeps 400 days. Building the
    // full decade and letting `prune` cut it back meant every scan cycle
    // deleted and re-inserted the same pre-retention rows out of a CRR table —
    // replicated account-wide, forever. The bound belongs at construction.
    const oldestDay = localDayKey(NOW_MS - ROLLUP_RETAINED_DAYS * 86_400_000);
    const beforeEdge = localDayKey(NOW_MS - (ROLLUP_RETAINED_DAYS + 1) * 86_400_000);
    const costs: CostSnapshot[] = [{
      provider: "claude",
      last30dCostUsd: 0,
      todayCostUsd: 0,
      tokenBreakdown: {},
      dailyTokenBreakdownByPreset: {
        all: {
          "2016-03-04": { sonnet: { input: 9, output: 9, cached: 0, costUsd: 9 } },
          [beforeEdge]: { sonnet: { input: 5, output: 5, cached: 0, costUsd: 5 } },
          [oldestDay]: { sonnet: { input: 1, output: 1, cached: 0, costUsd: 1 } },
          [TODAY]: { sonnet: { input: 2, output: 2, cached: 0, costUsd: 2 } },
        },
      },
      dailyTokensByPreset: { all: { "2016-03-04": 100, [oldestDay]: 4, [TODAY]: 4 } },
    }];

    // The edge day itself is kept: `prune` deletes `day < oldestDay`, so the
    // two agree exactly rather than differing by one day in either direction.
    expect(buildRollupRows(costs, { oldestDay }).map((row) => row.date))
      .toEqual([oldestDay, TODAY]);
    // No bound is still the whole archive, for a caller that wants one.
    expect(buildRollupRows(costs).map((row) => row.date))
      .toEqual(["2016-03-04", beforeEdge, oldestDay, TODAY]);
  });

  it("republishes a bounded rollup without writing or deleting anything", () => {
    // The loop, closed: prune has already removed the pre-retention days, the
    // store holds exactly what the last publish wrote, and this publish must
    // therefore issue no upsert, no delete, and report no change — otherwise
    // every scan cycle emits a full delete-changeset and insert-changeset of
    // pre-retention history to every desktop on the account.
    const oldestDay = localDayKey(NOW_MS - ROLLUP_RETAINED_DAYS * 86_400_000);
    const costs: CostSnapshot[] = [{
      provider: "claude",
      last30dCostUsd: 0,
      todayCostUsd: 0,
      tokenBreakdown: {},
      dailyTokenBreakdownByPreset: {
        all: {
          "2016-03-04": { sonnet: { input: 9, output: 9, cached: 0, costUsd: 9 } },
          [TODAY]: { sonnet: { input: 1, output: 1, cached: 0, costUsd: 0.01 } },
        },
      },
    }];
    const rows = buildRollupRows(costs, { oldestDay });
    const published: AdeUsageRollup = { ...rollup(rows), capturedAt: "2026-08-09T12:00:00.000Z" };
    const stored = rows.map((row) => storedRow({
      day: row.date,
      provider: row.provider,
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cached_tokens: row.cachedTokens,
      total_tokens: row.totalTokens,
      cost_usd: row.costUsd,
      calls: row.calls,
    }));

    const quiet = fakeDb(stored, storedMetaFor(published));
    expect(createAccountUsageRollupStore({ db: quiet.db }).publish(published)).toBe(false);
    expect(quiet.deletes()).toEqual([]);
    expect(quiet.upserts()).toEqual([]);

    // Control: the unbounded build is what used to be published, and against
    // the same pruned store it reports a change and re-inserts the decade-old
    // row that prune had just deleted.
    const churning = fakeDb(stored, storedMetaFor(published));
    const unbounded: AdeUsageRollup = { ...published, rows: buildRollupRows(costs) };
    expect(createAccountUsageRollupStore({ db: churning.db }).publish(unbounded)).toBe(true);
    expect(churning.upserts().map((entry) => entry.params[1])).toEqual(["2016-03-04"]);
  });
});

type Statement = { sql: string; params: unknown[] };

type StoredRow = {
  machine_key: string;
  day: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  calls: number;
};

function storedRow(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    machine_key: "laptop",
    day: "2026-08-01",
    provider: "claude",
    model: "sonnet",
    input_tokens: 1,
    output_tokens: 1,
    cached_tokens: 0,
    total_tokens: 2,
    cost_usd: 0.01,
    calls: 0,
    ...overrides,
  };
}

/**
 * Minimal `AdeDb` stand-in that records the statements the store issues and
 * answers its reads from a fixed set of stored rows.
 *
 * The store's contract that matters here is *which* statements it runs — a
 * `delete` against a live machine's rows is the whole hazard, and an upsert it
 * did not need to run is the loop hazard — so recording SQL is a truer test
 * than asserting on a table's final contents would be.
 */
function fakeDb(
  existingRows: StoredRow[] = [],
  existingMeta: Record<string, unknown> | null = null,
) {
  const statements: Statement[] = [];
  const db = {
    run: (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
    },
    get: (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return /usage_machine_rollup_meta/i.test(sql) ? existingMeta : null;
    },
    all: (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return /usage_machine_rollup_meta/i.test(sql)
        ? (existingMeta ? [existingMeta] : [])
        : existingRows;
    },
  } as unknown as AdeDb;
  return {
    db,
    statements,
    deletes: () => statements.filter((entry) => /^\s*delete/i.test(entry.sql)),
    upserts: () => statements.filter((entry) => /^\s*insert into usage_machine_rollups\b/i.test(entry.sql)),
    metaWrites: () => statements.filter((entry) => /^\s*insert into usage_machine_rollup_meta\b/i.test(entry.sql)),
  };
}

function rollupRow(overrides: Partial<AdeUsageRollupRow> = {}): AdeUsageRollupRow {
  return {
    date: "2026-08-01",
    provider: "claude",
    model: "sonnet",
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    totalTokens: 2,
    costUsd: 0.01,
    calls: 0,
    ...overrides,
  };
}

function rollup(rows: AdeUsageRollupRow[]): AdeUsageRollup {
  return {
    version: 1,
    machineKey: "laptop",
    label: "Laptop",
    platform: "darwin",
    capturedAt: "2026-08-09T00:00:00.000Z",
    source: { sourceId: "laptop-marker", roots: ["abc"] },
    rows,
  };
}

/** The meta row a `publish` of `rollup(...)` would have left behind. */
function storedMetaFor(published: AdeUsageRollup): Record<string, unknown> {
  return {
    machine_key: published.machineKey,
    label: published.label,
    platform: published.platform,
    captured_at: published.capturedAt,
    source_id: published.source.sourceId,
    source_roots: JSON.stringify(published.source.roots),
  };
}

describe("account usage rollup store", () => {
  it("never reconciles away stored history when the incoming rollup has no rows", () => {
    // A peer answering mid-first-scan reports zero rows. Taking that as
    // authoritative would delete every stored day for that machine — and these
    // are CRR tables, so the deletes replicate to the whole account.
    const { db, statements, deletes } = fakeDb([
      storedRow({ day: "2026-08-01" }),
      storedRow({ day: "2026-08-02", provider: "codex", model: "gpt" }),
    ]);
    const store = createAccountUsageRollupStore({ db });

    expect(store.publish(rollup([]))).toBe(true);
    expect(deletes()).toEqual([]);
    // It does not even read the existing rows: there is nothing to reconcile.
    expect(statements.some((entry) => /select .* from usage_machine_rollups\b/i.test(entry.sql))).toBe(false);
    // The meta row is still refreshed, so the machine keeps its label and
    // captured-at even while it is still warming up.
    expect(statements.some((entry) => /insert into usage_machine_rollup_meta/i.test(entry.sql))).toBe(true);
  });

  it("still reconciles away a row that vanished from a non-empty rollup", () => {
    const { db, deletes } = fakeDb([
      storedRow({ day: "2026-08-01" }),
      storedRow({ day: "2026-07-04", model: "retired" }),
    ]);
    const store = createAccountUsageRollupStore({ db });

    expect(store.publish(rollup([rollupRow()]))).toBe(true);
    const removed = deletes();
    expect(removed).toHaveLength(1);
    expect(removed[0]?.params).toEqual(["laptop", "2026-07-04", "claude", "retired"]);
  });

  it("keeps a provider's stored history when that provider's scan failed this round", () => {
    // A flaky mount makes the Claude scan throw. Codex still produced rows, so
    // the zero-row guard does not fire — and without the per-provider guard
    // every stored Claude day for this machine is deleted out of a
    // CRR-replicated table and the deletes replicate account-wide.
    const stored = [
      storedRow({ day: "2026-08-01", provider: "codex", model: "gpt" }),
      storedRow({ day: "2026-08-01", provider: "claude", model: "sonnet" }),
      storedRow({ day: "2026-07-04", provider: "claude", model: "opus" }),
    ];
    const incoming = rollup([rollupRow({ provider: "codex", model: "gpt" })]);

    const failed = fakeDb([...stored]);
    createAccountUsageRollupStore({ db: failed.db })
      .publish(incoming, { skipReconcileProviders: ["claude"] });
    expect(failed.deletes()).toEqual([]);

    // Control: with no failed provider reported, the same silence really does
    // mean the rows are gone and the reconcile still runs.
    const clean = fakeDb([...stored]);
    createAccountUsageRollupStore({ db: clean.db }).publish(incoming);
    expect(clean.deletes().map((entry) => entry.params)).toEqual([
      ["laptop", "2026-08-01", "claude", "sonnet"],
      ["laptop", "2026-07-04", "claude", "opus"],
    ]);
  });

  it("does not let a peer publish delete a provider the payload never mentioned", () => {
    // The peer-publish path is how `skipReconcileProviders` gets defeated. A
    // failed provider is absent from the owner's `scanResult.costs`, so it is
    // absent from what `getUsageRollup` hands a peer — and the peer has no
    // failure list to pass. Machine A fetches B, sees B's Claude rows as
    // vanished, deletes them under `machine_key = B`, and because these are CRR
    // tables the deletes replicate back to B and account-wide, undoing exactly
    // the protection B applied to itself. B only restores them when its own
    // scan succeeds, which for an unreadable mount is never.
    const stored = [
      storedRow({ day: "2026-08-01", provider: "codex", model: "gpt" }),
      storedRow({ day: "2026-08-01", provider: "claude", model: "sonnet" }),
      storedRow({ day: "2026-07-04", provider: "claude", model: "retired" }),
    ];
    const fetched = rollup([rollupRow({ provider: "codex", model: "gpt" })]);

    const peer = fakeDb([...stored]);
    createAccountUsageRollupStore({ db: peer.db }).publish(fetched, { ownerAuthoritative: false });
    expect(peer.deletes()).toEqual([]);

    // Control: a provider the payload *did* report is still reconciled, so a
    // genuine removal inside a reported provider still lands. `codex|gpt` is
    // present; `codex|retired` is not, and goes.
    const withinReported = fakeDb([
      storedRow({ day: "2026-08-01", provider: "codex", model: "gpt" }),
      storedRow({ day: "2026-07-04", provider: "codex", model: "retired" }),
      storedRow({ day: "2026-07-04", provider: "claude", model: "sonnet" }),
    ]);
    createAccountUsageRollupStore({ db: withinReported.db })
      .publish(fetched, { ownerAuthoritative: false });
    expect(withinReported.deletes().map((entry) => entry.params)).toEqual([
      ["laptop", "2026-07-04", "codex", "retired"],
    ]);
  });

  it("reports no change — and writes nothing — when the same rollup is published twice", () => {
    // This is the whole reason `publish` has a return value. Account scope
    // re-reads on every usage update, and every read starts a live refresh, so
    // a republish that reported "changed" would emit an update, cause a read,
    // and spin the page for as long as it was open.
    const published = rollup([rollupRow()]);
    const { db, deletes, upserts, metaWrites } = fakeDb(
      [storedRow()],
      storedMetaFor(published),
    );
    const store = createAccountUsageRollupStore({ db });

    expect(store.publish(published)).toBe(false);
    expect(upserts()).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(metaWrites()).toEqual([]);
  });

  it("reports a change when a single stored row's numbers moved", () => {
    const published = rollup([rollupRow({ totalTokens: 3, outputTokens: 2 })]);
    const { db, upserts, metaWrites } = fakeDb([storedRow()], storedMetaFor(published));
    const store = createAccountUsageRollupStore({ db });

    expect(store.publish(published)).toBe(true);
    expect(upserts()).toHaveLength(1);
    // Only the row moved, so the meta record is left alone and its CRR clock
    // does not tick.
    expect(metaWrites()).toEqual([]);
  });

  it("writes the fresh capture time but does not report it as a change", () => {
    // The other half of the refresh loop. Every republish carries a new
    // `capturedAt`, so if freshness alone counted as a change, a byte-identical
    // republish would wake every usage subscriber, the renderer would re-read,
    // the read would start the next refresh, and the page would spin for as
    // long as it was open — exactly what the return value exists to prevent.
    // The timestamp is still persisted: peers rank a machine by it and the page
    // renders it as "last reported".
    const published = rollup([rollupRow()]);
    const stale = { ...storedMetaFor(published), captured_at: "2026-08-08T00:00:00.000Z" };
    const { db, upserts, metaWrites } = fakeDb([storedRow()], stale);
    const store = createAccountUsageRollupStore({ db });

    expect(store.publish(published)).toBe(false);
    expect(upserts()).toEqual([]);
    expect(metaWrites()).toHaveLength(1);
    expect(metaWrites()[0]?.params).toContain(published.capturedAt);
  });

  it("still reports a change when the machine's identity moved", () => {
    // The control for the test above: `changed` must stay true for a real
    // identity change, which is rare and genuinely worth a fan-out.
    const published = rollup([rollupRow()]);
    for (const stored of [
      { ...storedMetaFor(published), label: "Old name" },
      { ...storedMetaFor(published), platform: "win32" },
      { ...storedMetaFor(published), source_id: "other-marker" },
      { ...storedMetaFor(published), source_roots: JSON.stringify(["different"]) },
    ]) {
      const { db, metaWrites } = fakeDb([storedRow()], stored);
      expect(createAccountUsageRollupStore({ db }).publish(published)).toBe(true);
      expect(metaWrites()).toHaveLength(1);
    }
  });

  it("round-trips a machine's identity through the meta row", () => {
    const reader = fakeDb([storedRow()], storedMetaFor(rollup([rollupRow()])));
    const readBack = createAccountUsageRollupStore({ db: reader.db }).readAll();
    expect(readBack[0]?.source).toEqual({ sourceId: "laptop-marker", roots: ["abc"] });
  });

  it("retains enough days for the longest range preset and not much more", () => {
    // `year` asks for 365 days; the remainder absorbs timezone skew and the gap
    // between a peer's last publish and the day the reader asks about.
    expect(ROLLUP_RETAINED_DAYS).toBeGreaterThan(365);
    expect(ROLLUP_RETAINED_DAYS).toBeLessThanOrEqual(400);
  });
});

const TIMEOUT_MS = 40;

function machines(...keys: string[]): AdeAccountMachinesResult {
  return {
    state: "ok",
    machines: keys.map((machineKey) => ({
      machineKey,
      name: machineKey,
      customName: null,
      platform: "darwin",
      online: true,
    })),
    message: null,
  } as unknown as AdeAccountMachinesResult;
}

function validRollup(machineKey: string): AdeUsageRollup {
  return {
    version: 1,
    machineKey,
    label: machineKey,
    platform: "darwin",
    capturedAt: "2026-08-09T00:00:00.000Z",
    source: { sourceId: `${machineKey}-marker`, roots: ["abc"] },
    rows: [],
  };
}

function deadline(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

describe("account rollup live refresh", () => {
  it("never calls a target that is not already connected", async () => {
    const called: string[] = [];
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop", "studio"),
      resolveTargetIdForMachineKey: (machineKey) => `target-${machineKey}`,
      isTargetConnected: (targetId) => targetId === "target-studio",
      callMachineMethod: async (targetId) => {
        called.push(targetId);
        return validRollup("studio") as never;
      },
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      // The disconnected laptop is left to its durable rollup. Calling it would
      // route through the implicit-reconnect path and spend that machine's
      // automatic-reconnect budget on an optional page refresh.
      expect(called).toEqual(["target-studio"]);
      expect(result.rollups.map((entry) => entry.machineKey)).toEqual(["studio"]);
      expect(result.failures).toEqual([]);
    } finally {
      cancel();
    }
  });

  it("passes the refresh deadline down as the call timeout", async () => {
    const seen: Array<number | undefined> = [];
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async (_targetId, _method, _params, options) => {
        seen.push(options?.timeoutMs);
        return validRollup("laptop") as never;
      },
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      await fetch({ timeoutMs: TIMEOUT_MS, signal });
      expect(seen).toEqual([TIMEOUT_MS]);
    } finally {
      cancel();
    }
  });

  it("gives up on a hanging peer at the deadline instead of waiting for the pool", async () => {
    let released = (): void => {};
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop", "studio"),
      resolveTargetIdForMachineKey: (machineKey) => `target-${machineKey}`,
      isTargetConnected: () => true,
      callMachineMethod: async (targetId) => {
        if (targetId === "target-laptop") {
          // A peer whose connection is up but whose process is wedged: this
          // never settles until the test releases it.
          return await new Promise<never>((_resolve, reject) => {
            released = () => reject(new Error("released"));
          });
        }
        return validRollup("studio") as never;
      },
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      const elapsed = Date.now() - startedAt;
      // Settled at the deadline, not held open by the wedged peer — which is
      // what keeps the caller's in-flight key from suppressing later refreshes.
      expect(elapsed).toBeLessThan(TIMEOUT_MS * 8);
      expect(result.rollups.map((entry) => entry.machineKey)).toEqual(["studio"]);
      expect(result.failures.map((entry) => entry.machineKey)).toEqual(["laptop"]);
    } finally {
      cancel();
      released();
    }
  });

  it("records a retryable failure when a peer answers null because it has not scanned yet", async () => {
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => null as never,
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      // Crucially not a rollup: storing an empty one would have the store
      // reconcile away everything it already knows about that machine.
      expect(result.rollups).toEqual([]);
      expect(result.failures).toEqual([{
        machineKey: "laptop",
        label: "laptop",
        platform: "darwin",
        message: "This computer is still reading its usage history",
      }]);
    } finally {
      cancel();
    }
  });

  it("drops malformed rows and bounds the source record instead of handing them to the store", async () => {
    // A row whose scalars are the wrong shape makes `db.run` throw inside
    // `publish`, which swallows it — after an unknown number of rows were
    // written and before the delete-reconcile ran, leaving stored history
    // half-updated. And `roots` is JSON-stringified into a CRR meta cell with
    // nothing bounding it.
    const goodRow = {
      date: "2026-08-01",
      provider: "claude",
      model: "sonnet",
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      totalTokens: 2,
      costUsd: 0.01,
      calls: 1,
    };
    const hostile = {
      ...validRollup("laptop"),
      rows: [
        goodRow,
        { ...goodRow, inputTokens: { nested: true } },
        { ...goodRow, date: 20260801 },
        { ...goodRow, totalTokens: Number.POSITIVE_INFINITY },
        null,
        "not-a-row",
      ],
      source: {
        sourceId: "s".repeat(400),
        roots: ["r".repeat(400), ...Array.from({ length: 200 }, (_, index) => `root-${index}`), 7],
      },
    };
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => hostile as never,
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      const stored = result.rollups[0];
      expect(stored?.rows).toEqual([goodRow]);
      expect(stored?.source.roots).toHaveLength(32);
      expect(stored?.source.roots.every((root) => typeof root === "string" && root.length <= 128)).toBe(true);
      expect(stored?.source.sourceId?.length).toBe(128);
    } finally {
      cancel();
    }
  });

  it("still reports a host too old to answer at all", async () => {
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => ({ notARollup: true }) as never,
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      expect(result.failures[0]?.message).toBe("This computer's ADE is too old to share usage");
    } finally {
      cancel();
    }
  });

  async function failureMessageFor(rejection: unknown): Promise<string | undefined> {
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => {
        throw rejection;
      },
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      return result.failures[0]?.message;
    } finally {
      cancel();
    }
  }

  it("says a peer is too old rather than unreachable when it rejects the method", async () => {
    // A brain predating `usage.getUsageRollup` rejects with -32601. Reported as
    // "Couldn't reach this computer" it sends the user looking at the network
    // for a version mismatch. These are the two shapes an unknown method really
    // produces, after `runtimeRpcClient` has flattened the JSON-RPC error into
    // a plain Error — note it keeps no `.code`, so the text is all there is.
    const rejections = [
      new Error(
        "Remote ADE service method usage.getUsageRollup failed (code -32601): Method not found: usage.getUsageRollup",
      ),
      new Error(
        "Remote ADE service method usage.getUsageRollup failed: Unsupported remote command: usage.getUsageRollup",
      ),
    ];
    for (const rejection of rejections) {
      expect(await failureMessageFor(rejection)).toBe("This computer's ADE is too old to share usage");
    }
  });

  it("does not read an authorization denial as an out-of-date peer", async () => {
    // ADE throws `methodNotFound` for permission denials too (adeRpcServer's
    // elevated-role and owner-scope refusals). Matching the -32601 code, or the
    // "unsupported <x> method" phrasing those denials wear, turns a real scope
    // problem into "this computer is too old" — the exact bug class ADE has
    // shipped before.
    const denials = [
      Object.assign(
        new Error(
          "Remote ADE service method usage.getUsageRollup failed (code -32601): Action 'usage.getUsageRollup' requires elevated role.",
        ),
        { code: -32601 },
      ),
      new Error(
        "Remote ADE service method usage.getUsageRollup failed (code -32601): Proof listing requires an authenticated owner scope.",
      ),
      new Error("Remote ADE service method usage.getUsageRollup failed (code -32601): Unsupported chat method"),
    ];
    for (const denial of denials) {
      expect(await failureMessageFor(denial)).toBe("Couldn't reach this computer");
    }
  });

  it("bounds what a peer can hand the store", async () => {
    // `rows` and `source.window` are peer-controlled and land in CRR-replicated
    // tables. The guard only checked `Array.isArray(rows)`, so one machine could
    // put an unbounded payload into every other machine's database.
    const rows = Array.from({ length: 200_000 }, (_unused, index) => ({
      date: "2026-08-01",
      provider: "claude",
      model: `model-${index}`,
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      totalTokens: 2,
      costUsd: 0,
      calls: 0,
    }));
    const oversized: AdeUsageRollup = {
      ...validRollup("laptop"),
      rows,
    };

    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => oversized as never,
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      const accepted = result.rollups[0];
      if (!accepted) throw new Error("expected the peer to still contribute");
      // Truncated, not rejected: an odd payload costs that machine precision.
      expect(accepted.rows.length).toBeLessThanOrEqual(80_000);
      expect(accepted.rows.length).toBeLessThan(rows.length);
      expect(result.failures).toEqual([]);
    } finally {
      cancel();
    }
  });

  it("clamps peer row scalars to non-negative integers", async () => {
    // Finiteness was checked; sign and integrality were not. `foldRollupsIntoStats`
    // adds these straight into the account total, the daily chart point and the
    // per-machine sort with no clamp of its own, so a negative drives the page's
    // numbers *down* — and a fraction reaches an `integer not null` column via
    // SQLite type affinity.
    const hostile: AdeUsageRollup = {
      ...validRollup("laptop"),
      rows: [{
        date: "2026-08-01",
        provider: "claude",
        model: "sonnet",
        inputTokens: -1e12,
        outputTokens: 1.5,
        cachedTokens: -0.5,
        totalTokens: -1e12,
        costUsd: -1_000,
        calls: 2.9,
      }] as never,
    };
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => hostile as never,
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      expect(result.rollups[0]?.rows).toEqual([{
        date: "2026-08-01",
        provider: "claude",
        model: "sonnet",
        inputTokens: 0,
        outputTokens: 1,
        cachedTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        calls: 2,
      }]);
    } finally {
      cancel();
    }
  });

  it("survives a non-string label and an unparseable capture time", async () => {
    // `rollup.label?.trim()` throws `TypeError` for a numeric label, and the
    // handler's catch dresses that as "Couldn't reach this computer" — pointing
    // the user at the network for a payload-shape problem. `capturedAt` is fed
    // to `Date.parse` and rendered as `lastReportedAt`, and all three of label,
    // platform and capturedAt land unbounded in the same CRR meta row the
    // source fields are capped for.
    const odd = {
      ...validRollup("laptop"),
      label: 42,
      platform: { evil: true },
      capturedAt: "not a date",
    } as unknown as AdeUsageRollup;
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => odd as never,
      localMachineKey: () => "this-machine",
    });

    const before = Date.now();
    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      expect(result.failures).toEqual([]);
      const accepted = result.rollups[0];
      if (!accepted) throw new Error("expected the peer to still contribute");
      // Falls back to what the directory says, rather than reporting the
      // machine as unreachable.
      expect(accepted.label).toBe("laptop");
      expect(accepted.platform).toBe("darwin");
      // An unparseable capture time becomes the time this refresh actually
      // heard from the machine.
      expect(Date.parse(accepted.capturedAt)).toBeGreaterThanOrEqual(before);
    } finally {
      cancel();
    }
  });

  it("caps an oversized label, platform and capture time", async () => {
    const huge = {
      ...validRollup("laptop"),
      label: "L".repeat(5_000),
      platform: "P".repeat(5_000),
      capturedAt: `2026-08-09T00:00:00.000Z${"z".repeat(5_000)}`,
    } as unknown as AdeUsageRollup;
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => huge as never,
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const accepted = (await fetch({ timeoutMs: TIMEOUT_MS, signal })).rollups[0];
      if (!accepted) throw new Error("expected the peer to still contribute");
      expect(accepted.label.length).toBeLessThanOrEqual(128);
      expect((accepted.platform ?? "").length).toBeLessThanOrEqual(128);
      expect(accepted.capturedAt.length).toBeLessThanOrEqual(128);
    } finally {
      cancel();
    }
  });

  it("drops fields this version does not read instead of storing them", async () => {
    // The payload is attacker-controlled. Spreading it and overriding the known
    // fields carries every unlisted key straight through into the store, so the
    // accepted rollup is rebuilt field by field from the accepted set only.
    const smuggled = {
      ...validRollup("laptop"),
      __proto__unused: "x",
      adminOverride: true,
      extraRows: [{ date: "2026-08-01" }],
      version: 99,
    } as unknown as AdeUsageRollup;
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => smuggled as never,
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const accepted = (await fetch({ timeoutMs: TIMEOUT_MS, signal })).rollups[0];
      if (!accepted) throw new Error("expected the peer to still contribute");
      expect(Object.keys(accepted).sort()).toEqual([
        "capturedAt",
        "label",
        "machineKey",
        "platform",
        "rows",
        "source",
        "version",
      ]);
      // The wire version is this version's, not whatever the peer claimed.
      expect(accepted.version).toBe(1);
      expect(Object.keys(accepted.source).sort()).toEqual(["roots", "sourceId"]);
    } finally {
      cancel();
    }
  });

  it("still reports a genuine transport failure as unreachable", async () => {
    const fetch = createAccountRollupFetcher({
      listMachines: async () => machines("laptop"),
      resolveTargetIdForMachineKey: () => "target-laptop",
      isTargetConnected: () => true,
      callMachineMethod: async () => {
        throw new Error("socket hang up");
      },
      localMachineKey: () => "this-machine",
    });

    const { signal, cancel } = deadline(TIMEOUT_MS);
    try {
      const result = await fetch({ timeoutMs: TIMEOUT_MS, signal });
      expect(result.failures[0]?.message).toBe("Couldn't reach this computer");
    } finally {
      cancel();
    }
  });
});

// ---------------------------------------------------------------------------
// Local machine identity — the key every peer files this computer's usage under
// ---------------------------------------------------------------------------

describe("local account machine identity", () => {
  it("treats a Windows delete-pending race as contention, and a real failure as fatal", () => {
    // Windows does not unlink a name until every handle to it closes, so a
    // concurrent `wx` against a delete-pending name reports EPERM/EACCES/EBUSY
    // where POSIX reports EEXIST. Reading those as fatal makes the caller
    // publish nothing, and the machine silently drops out of the account
    // directory. This is the branch a macOS or Linux runner can never reach on
    // its own, which is exactly why the platform is injected.
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const error = Object.assign(new Error(code), { code });
      expect(isCreateContention(error, "win32")).toBe(true);
      expect(isCreateContention(error, "darwin")).toBe(false);
      expect(isCreateContention(error, "linux")).toBe(false);
    }

    // EEXIST is contention everywhere.
    const exists = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(isCreateContention(exists, platform)).toBe(true);
    }

    // A genuinely fatal write must still throw on Windows rather than being
    // swallowed as a race — otherwise a read-only or full disk reads as
    // "someone else won" and the caller re-reads a file that is not there.
    const readOnly = Object.assign(new Error("EROFS"), { code: "EROFS" });
    expect(isCreateContention(readOnly, "win32")).toBe(false);
    expect(isCreateContention(new Error("no code at all"), "win32")).toBe(false);
    expect(isCreateContention(null, "win32")).toBe(false);
  });

  it("re-reads the id the winner wrote instead of minting a second identity", () => {
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-identity-"));
    try {
      // The machine that won the race already left its id on disk.
      fs.writeFileSync(path.join(secretsDir, "sync-device-id"), "winner-device-id\n");

      const identity = getOrCreateLocalAccountMachineIdentity({
        secretsDir,
        randomUUID: () => "loser-device-id",
        platform: "win32",
      });

      // Publishing under the losing id would file this computer's usage under a
      // second, phantom machine that no peer ever reconciles with the real one.
      expect(identity.deviceId).toBe("winner-device-id");
      expect(identity.machineKey).toBeTruthy();
      expect(fs.readFileSync(path.join(secretsDir, "sync-device-id"), "utf8").trim())
        .toBe("winner-device-id");

      // Same directory, same answer — the identity is stable across calls.
      expect(getOrCreateLocalAccountMachineIdentity({ secretsDir }).deviceId)
        .toBe("winner-device-id");
    } finally {
      fs.rmSync(secretsDir, { recursive: true, force: true });
    }
  });
});
