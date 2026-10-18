import { describe, expect, it } from "vitest";
import type {
  DbBreakdownEntry,
  MaintenanceRunReport,
  RuntimeHealthSnapshot,
  StorageCategorySnapshot,
  StorageItem,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import type { AppResourceUsageSnapshot } from "../../../../shared/types";
import {
  buildCleanupTarget,
  buildSafeCleanupPlan,
  categoryPolicyChip,
  dbBreakdownRows,
  dbSizeSamples,
  dbSizeTrend,
  formatApproxBytes,
  formatRunClock,
  journalEntries,
  lastMaintenanceRun,
  ledgerLabel,
  maintenanceActionLines,
  maintenanceHeadline,
  loadChip,
  maintenanceOutcome,
  responseHealth,
  safeReclaimableBytes,
  serviceMemory,
  sparklinePoints,
} from "./storageView";

const MB = 1024 ** 2;

function run(partial: Partial<MaintenanceRunReport>): MaintenanceRunReport {
  return {
    startedAt: "2026-07-16T03:12:00.000Z",
    finishedAt: "2026-07-16T03:12:05.000Z",
    trigger: "daily",
    actions: [],
    reclaimedBytes: 0,
    dbSizeBytes: null,
    ...partial,
  };
}

describe("safeReclaimableBytes / formatApproxBytes", () => {
  it("returns the positive daemon estimate, else zero", () => {
    expect(safeReclaimableBytes({ safeReclaimableBytes: 5 * MB } as StorageSnapshotExtras)).toBe(5 * MB);
    expect(safeReclaimableBytes({ safeReclaimableBytes: 0 } as StorageSnapshotExtras)).toBe(0);
    expect(safeReclaimableBytes({ safeReclaimableBytes: -3 } as StorageSnapshotExtras)).toBe(0);
    expect(safeReclaimableBytes(undefined)).toBe(0);
  });

  it("prefixes the humanized size with a tilde", () => {
    expect(formatApproxBytes(2 * 1024 ** 3)).toBe("~2.0 GB");
  });
});

describe("categoryPolicyChip", () => {
  it("reads the chip for a category, ignoring blanks and absence", () => {
    const extras = { policyChips: { caches: "Rebuilt on demand", chats_history: "  " } } as unknown as StorageSnapshotExtras;
    expect(categoryPolicyChip(extras, "caches")).toBe("Rebuilt on demand");
    expect(categoryPolicyChip(extras, "chats_history")).toBeUndefined();
    expect(categoryPolicyChip(extras, "database")).toBeUndefined();
    expect(categoryPolicyChip(undefined, "caches")).toBeUndefined();
  });
});

describe("dbBreakdownRows", () => {
  const entries: DbBreakdownEntry[] = [
    { table: "core", label: "Core data", bytes: 8 * MB, category: "core", action: null },
    { table: "automation_ingress_events", label: "Webhook history", bytes: 40 * MB, category: "webhooks", action: "prunable" },
    { table: "operations", label: "Sync bookkeeping", bytes: 20 * MB, category: "sync_bookkeeping", action: "compactable" },
    { table: "pr_snap", label: "Pull request cache", bytes: 4 * MB, category: "pr_cache", action: "compaction_pending" },
  ];

  it("sorts largest first and marks the tables Clean up safely trims", () => {
    const rows = dbBreakdownRows(entries);
    expect(rows.map((r) => r.label)).toEqual(["Webhook history", "Sync bookkeeping", "Core data", "Pull request cache"]);
    expect(rows.filter((r) => r.trimmedByCleanup).map((r) => r.table)).toEqual(["automation_ingress_events", "operations"]);
  });

  it("frames core data as protected and pending rows as pending, neither trimmed", () => {
    const rows = dbBreakdownRows(entries);
    const core = rows.find((r) => r.category === "core")!;
    expect(core.isProtected).toBe(true);
    expect(core.trimmedByCleanup).toBe(false);
    const pending = rows.find((r) => r.category === "pr_cache")!;
    expect(pending.isPending).toBe(true);
    expect(pending.trimmedByCleanup).toBe(false);
  });

  it("returns nothing for an absent breakdown", () => {
    expect(dbBreakdownRows(undefined)).toEqual([]);
  });
});

describe("ledgerLabel", () => {
  it("maps known ledger ids (exact keys) to plain names", () => {
    expect(ledgerLabel("db.automation_ingress_events")).toBe("Webhook history");
    expect(ledgerLabel("db.operations_crsql")).toBe("Sync bookkeeping");
    expect(ledgerLabel("db.pull_request_snapshots")).toBe("Pull request cache");
    expect(ledgerLabel("fs.transcripts")).toBe("Chat & terminal history");
    expect(ledgerLabel("fs.ios_derived_data")).toBe("iOS build cache");
  });

  it("title-cases an unknown id without leaking an identifier", () => {
    expect(ledgerLabel("some.mystery_thing")).toBe("Mystery thing");
  });
});

describe("maintenanceActionLines", () => {
  it("orders by reclaim and humanizes each action", () => {
    const report = run({
      actions: [
        { ledgerId: "db.automation_ingress_events", kind: "prune", itemsAffected: 100, bytesReclaimed: 128 * MB, durationMs: 12 },
        { ledgerId: "db.operations_crsql", kind: "compact", itemsAffected: 0, bytesReclaimed: 0, durationMs: 30 },
        { ledgerId: "db.pull_request_snapshots", kind: "prune", itemsAffected: 3, bytesReclaimed: 0, durationMs: 5, error: "nope" },
      ],
    });
    const lines = maintenanceActionLines(report);
    expect(lines[0].label).toBe("Webhook history");
    expect(lines[0].detail).toBe("reclaimed 128 MB");
    expect(lines.find((l) => l.label === "Sync bookkeeping")!.detail).toBe("compacted");
    const failed = lines.find((l) => l.label === "Pull request cache")!;
    expect(failed.failed).toBe(true);
    expect(failed.detail).toBe("couldn't finish");
  });

  it("reports partial failures instead of calling a zero-byte run tidy", () => {
    const report = run({
      reclaimedBytes: 0,
      actions: [
        { ledgerId: "fs.tmp", kind: "delete", itemsAffected: 0, bytesReclaimed: 0, durationMs: 4, error: "busy" },
      ],
    });
    expect(maintenanceOutcome(report)).toEqual({
      message: "Some cleanup steps couldn't finish",
      failed: true,
    });
  });
});

describe("formatRunClock / maintenanceHeadline", () => {
  // Build timestamps from LOCAL components so the day boundaries are
  // timezone-independent (formatRunClock buckets by the viewer's local day).
  const now = new Date(2026, 6, 17, 9, 0, 0);
  const todayIso = new Date(2026, 6, 17, 4, 0, 0).toISOString();
  const yesterdayIso = new Date(2026, 6, 16, 3, 12, 0).toISOString();

  it("labels today and yesterday", () => {
    expect(formatRunClock(todayIso, now).startsWith("Today ")).toBe(true);
    expect(formatRunClock(yesterdayIso, now).startsWith("Yesterday ")).toBe(true);
  });

  it("builds a headline with the reclaimed amount", () => {
    const headline = maintenanceHeadline(run({ finishedAt: yesterdayIso, reclaimedBytes: 481 * MB }), now);
    expect(headline).toContain("Yesterday");
    expect(headline).toContain("reclaimed 481 MB");
  });

  it("says nothing to reclaim when the run freed nothing", () => {
    expect(maintenanceHeadline(run({ reclaimedBytes: 0 }), now)).toContain("nothing to reclaim");
  });
});

describe("journalEntries / lastMaintenanceRun", () => {
  const older = run({ finishedAt: "2026-07-10T03:00:00.000Z" });
  const newer = run({ finishedAt: "2026-07-16T03:00:00.000Z" });
  const extras = { maintenance: { lastRun: null, journal: [older, newer] } } as unknown as StorageSnapshotExtras;

  it("returns newest first", () => {
    expect(journalEntries(extras)[0]).toBe(newer);
  });

  it("prefers the explicit lastRun, else the newest journal entry", () => {
    expect(lastMaintenanceRun(extras)).toBe(newer);
    const withLast = { maintenance: { lastRun: older, journal: [newer] } } as unknown as StorageSnapshotExtras;
    expect(lastMaintenanceRun(withLast)).toBe(older);
    expect(lastMaintenanceRun(undefined)).toBeNull();
  });
});

describe("dbSizeSamples / dbSizeTrend / sparklinePoints", () => {
  const extras = {
    maintenance: {
      lastRun: null,
      journal: [
        run({ finishedAt: "2026-07-16T03:00:00.000Z", dbSizeBytes: 100 * MB, dbSizeDefinition: "files" }),
        run({ finishedAt: "2026-07-10T03:00:00.000Z", dbSizeBytes: 200 * MB, dbSizeDefinition: "files" }),
        run({ finishedAt: "2026-07-12T03:00:00.000Z", dbSizeBytes: null, dbSizeDefinition: "files" }),
        // Measured the main file only: not comparable, so not in the trend.
        run({ finishedAt: "2026-07-14T03:00:00.000Z", dbSizeBytes: 20 * MB }),
      ],
    },
  } as unknown as StorageSnapshotExtras;

  it("extracts positive samples of one definition in chronological order", () => {
    const samples = dbSizeSamples(extras);
    expect(samples.map((s) => s.bytes)).toEqual([200 * MB, 100 * MB]);
  });

  it("detects a downward trend", () => {
    expect(dbSizeTrend(dbSizeSamples(extras))).toBe("down");
    expect(dbSizeTrend([{ ts: "x", bytes: 1 }])).toBeNull();
  });

  it("produces polyline points within the box", () => {
    const points = sparklinePoints(dbSizeSamples(extras), 100, 30);
    expect(points).toHaveLength(2);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(30);
    }
  });
});

describe("machine health helpers", () => {
  it("reports ADE service memory with its process count, else null", () => {
    const usage = {
      roleUsage: [
        { role: "ade-runtime", processCount: 2, cpuPercent: 2, memoryMB: 280 },
        { role: "electron-main", processCount: 1, cpuPercent: 5, memoryMB: 500 },
      ],
    } as unknown as AppResourceUsageSnapshot;
    expect(serviceMemory(usage)).toEqual({ bytes: 280 * MB, processCount: 2 });
    expect(serviceMemory({} as AppResourceUsageSnapshot)).toBeNull();
    expect(serviceMemory(null)).toBeNull();
  });

  it.each([
    [0, "Light"],
    [2, "Busy"],
    [4, "Heavy"],
  ] as const)("calls pressure level %i %s load", (level, label) => {
    expect(loadChip(level).label).toBe(label);
  });

  it.each([
    ["no snapshot", null, null],
    ["nothing slow", { slowActions24h: 0, slowActionP95Ms: null, failedActions24h: 2 }, { slow: 0, failed: 2, p95Ms: null }],
    ["slow with a p95", { slowActions24h: 3, slowActionP95Ms: 1200, failedActions24h: 0 }, { slow: 3, failed: 0, p95Ms: 1200 }],
    ["an older build without failures", { slowActions24h: 1, slowActionP95Ms: 700 }, { slow: 1, failed: null, p95Ms: 700 }],
  ] as const)("keeps slow and failed apart: %s", (_name, health, expected) => {
    expect(responseHealth(health as RuntimeHealthSnapshot | null)).toEqual(expected);
  });
});

describe("buildSafeCleanupPlan", () => {
  const categories: StorageCategorySnapshot[] = [
    {
      id: "chats_history",
      bytes: 900 * MB,
      fileCount: 10,
      safety: "compressible",
      compressibleBytes: 120 * MB,
      items: [],
    },
    {
      id: "caches",
      bytes: 300 * MB,
      fileCount: 5,
      safety: "safe_to_remove",
      items: [
        { id: "c1", label: "npm", path: "/proj/.ade/cache/npm", bytes: 300 * MB, fileCount: 5, lastModifiedAt: null, safety: "safe_to_remove" },
      ],
    },
    {
      id: "build_release",
      bytes: 200 * MB,
      fileCount: 2,
      safety: "safe_to_remove",
      items: [
        { id: "b1", label: "iOS build data", path: "/proj/.ade/cache/ios-simulator/DerivedData", bytes: 200 * MB, fileCount: 2, lastModifiedAt: null, safety: "safe_to_remove" },
      ],
    },
    {
      id: "recovery_backups",
      bytes: 140 * MB,
      fileCount: 2,
      safety: "review_first",
      items: [
        { id: "r-old", label: "Obsolete recovery backup", path: "/proj/.ade/ade.db.recovery-old.bak", bytes: 60 * MB, fileCount: 1, lastModifiedAt: "2026-06-01T00:00:00.000Z", safety: "safe_to_remove" },
        { id: "r-new", label: "Newest recovery backup", path: "/proj/.ade/ade.db.recovery-new.bak", bytes: 80 * MB, fileCount: 1, lastModifiedAt: "2026-07-01T00:00:00.000Z", safety: "safe_to_remove" },
      ],
    },
  ];
  const extras = {
    safeReclaimableBytes: 660 * MB,
    dbBreakdown: [
      { table: "automation_ingress_events", label: "Webhook history", bytes: 40 * MB, category: "webhooks", action: "prunable" },
      { table: "core", label: "Core data", bytes: 8 * MB, category: "core", action: null },
    ],
  } as unknown as StorageSnapshotExtras;

  it("puts on the button exactly what it removes, itemized, and promises no bytes for the rest", () => {
    const plan = buildSafeCleanupPlan({ categories, extras }, new Map());
    // npm 300 + iOS build data 200 + the obsolete backup 60; never the newest backup.
    expect(plan.estimatedBytes).toBe(560 * MB);
    expect(plan.rows.reduce((sum, row) => sum + row.bytes, 0)).toBe(plan.estimatedBytes);
    expect(plan.rows.map((row) => row.label)).toEqual(["npm", "iOS build data", "Old recovery backup"]);
    expect(plan.fsTargets).toEqual([
      { kind: "rebuildable_cache", path: "/proj/.ade/cache/npm" },
      { kind: "rebuildable_cache", path: "/proj/.ade/cache/ios-simulator/DerivedData" },
      { kind: "recovery_backup", path: "/proj/.ade/ade.db.recovery-old.bak" },
    ].sort((a, b) => a.path.length - b.path.length));
    expect(plan.alsoRuns.join(" ")).toContain("120 MB of old chat and terminal history");
    expect(plan.alsoRuns.join(" ")).toContain("Webhook history");
    expect(plan.alsoRuns.join(" ")).not.toContain("idle lanes");
    expect(plan.keeps).toContain("newest recovery backup");
  });

  it("counts a folder inside another target once, and groups same-named rows", () => {
    const nested: StorageCategorySnapshot[] = [
      {
        id: "caches",
        bytes: 50 * MB,
        fileCount: 2,
        safety: "safe_to_remove",
        items: [
          { id: "sim", label: "ios-simulator", path: "/proj/.ade/cache/ios-simulator", bytes: 50 * MB, fileCount: 1, lastModifiedAt: null, safety: "safe_to_remove" },
        ],
      },
      {
        id: "build_release",
        bytes: 230 * MB,
        fileCount: 3,
        safety: "safe_to_remove",
        items: [
          { id: "dd", label: "iOS build data", path: "/proj/.ade/cache/ios-simulator/DerivedData", bytes: 200 * MB, fileCount: 1, lastModifiedAt: null, safety: "safe_to_remove" },
          { id: "t1", label: "Release and build staging", path: "/tmp/ade-a", bytes: 20 * MB, fileCount: 1, lastModifiedAt: null, safety: "safe_to_remove" },
          { id: "t2", label: "Release and build staging", path: "/tmp/ade-b", bytes: 10 * MB, fileCount: 1, lastModifiedAt: null, safety: "safe_to_remove" },
          { id: "t3", label: "Release and build staging", path: "/tmp/ade-c", bytes: 0, fileCount: 0, lastModifiedAt: null, safety: "safe_to_remove" },
        ],
      },
    ];
    const plan = buildSafeCleanupPlan({ categories: nested }, new Map());
    expect(plan.fsTargets.map((target) => target.path)).not.toContain("/proj/.ade/cache/ios-simulator/DerivedData");
    expect(plan.rows).toEqual([
      { label: "ios-simulator", count: 1, bytes: 50 * MB },
      { label: "Release and build staging", count: 2, bytes: 30 * MB },
    ]);
  });

  it("says the idle-lane check runs first when the archive rules are on", () => {
    const plan = buildSafeCleanupPlan({ categories, extras, lifecycle: { policy: { cleanupIntervalHours: 24 } } }, new Map());
    expect(plan.alsoRuns[0]).toContain("idle lanes");
  });
});

describe("buildCleanupTarget", () => {
  const item = (p: string): StorageItem => ({
    id: p,
    label: "x",
    path: p,
    bytes: 1,
    fileCount: 1,
    lastModifiedAt: null,
    safety: "safe_to_remove",
  });

  it("maps a direct .ade/tmp child to stale_tmp_staging", () => {
    expect(buildCleanupTarget("build_release", item("/proj/.ade/tmp/ios-testflight-1"), new Map()))
      .toEqual({ kind: "stale_tmp_staging", path: "/proj/.ade/tmp/ios-testflight-1" });
  });

  it("does not map a deeper (grandchild) .ade/tmp path", () => {
    expect(buildCleanupTarget("build_release", item("/proj/.ade/tmp/ios-testflight-1/nested"), new Map()))
      .toBeNull();
  });

  it("still maps system ade-* staging and .ade/cache paths", () => {
    expect(buildCleanupTarget("build_release", item("/tmp/ade-run-9"), new Map()))
      .toEqual({ kind: "stale_tmp_staging", path: "/tmp/ade-run-9" });
    expect(buildCleanupTarget("caches", item("/proj/.ade/cache/npm"), new Map()))
      .toEqual({ kind: "rebuildable_cache", path: "/proj/.ade/cache/npm" });
  });
});
