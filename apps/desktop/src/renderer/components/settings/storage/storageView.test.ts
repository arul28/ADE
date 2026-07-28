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
  daemonMemoryBytes,
  dbBreakdownRows,
  dbSizeSamples,
  dbSizeTrend,
  formatApproxBytes,
  formatRunClock,
  formatSlowActions,
  healthChip,
  journalEntries,
  lastMaintenanceRun,
  ledgerLabel,
  maintenanceActionLines,
  maintenanceHeadline,
  maintenanceOutcome,
  safeReclaimableBytes,
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

  it("sorts largest first and maps actions to friendly labels", () => {
    const rows = dbBreakdownRows(entries);
    expect(rows.map((r) => r.label)).toEqual(["Webhook history", "Sync bookkeeping", "Core data", "Pull request cache"]);
    const webhook = rows.find((r) => r.table === "automation_ingress_events")!;
    expect(webhook.actionLabel).toBe("Clean up");
    const ops = rows.find((r) => r.table === "operations")!;
    expect(ops.actionLabel).toBe("Compact now");
  });

  it("frames core data as protected with no action", () => {
    const core = dbBreakdownRows(entries).find((r) => r.category === "core")!;
    expect(core.isProtected).toBe(true);
    expect(core.actionLabel).toBeNull();
  });

  it("marks compaction_pending rows as pending with no action", () => {
    const pending = dbBreakdownRows(entries).find((r) => r.category === "pr_cache")!;
    expect(pending.isPending).toBe(true);
    expect(pending.actionLabel).toBeNull();
  });

  it("returns nothing for an absent breakdown", () => {
    expect(dbBreakdownRows(undefined)).toEqual([]);
  });
});

describe("ledgerLabel", () => {
  it("maps known ledger ids (exact keys) to plain names", () => {
    expect(ledgerLabel("db.automation_ingress_events")).toBe("Webhook history");
    expect(ledgerLabel("db.operations_crsql")).toBe("Sync bookkeeping");
    expect(ledgerLabel("db.review_run_artifacts")).toBe("Review artifacts");
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
        { ledgerId: "db.review_run_artifacts", kind: "delete", itemsAffected: 3, bytesReclaimed: 0, durationMs: 5, error: "nope" },
      ],
    });
    const lines = maintenanceActionLines(report);
    expect(lines[0].label).toBe("Webhook history");
    expect(lines[0].detail).toBe("reclaimed 128 MB");
    expect(lines.find((l) => l.label === "Sync bookkeeping")!.detail).toBe("compacted");
    const failed = lines.find((l) => l.label === "Review artifacts")!;
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
        run({ finishedAt: "2026-07-16T03:00:00.000Z", dbSizeBytes: 100 * MB }),
        run({ finishedAt: "2026-07-10T03:00:00.000Z", dbSizeBytes: 200 * MB }),
        run({ finishedAt: "2026-07-12T03:00:00.000Z", dbSizeBytes: null }),
      ],
    },
  } as unknown as StorageSnapshotExtras;

  it("extracts positive samples in chronological order", () => {
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
  it("sums ade-runtime resident memory to bytes, else null", () => {
    const usage = {
      roleUsage: [
        { role: "ade-runtime", processCount: 1, cpuPercent: 2, memoryMB: 280 },
        { role: "electron-main", processCount: 1, cpuPercent: 5, memoryMB: 500 },
      ],
    } as unknown as AppResourceUsageSnapshot;
    expect(daemonMemoryBytes(usage)).toBe(280 * MB);
    expect(daemonMemoryBytes({} as AppResourceUsageSnapshot)).toBeNull();
    expect(daemonMemoryBytes(null)).toBeNull();
  });

  it("maps pressure level to a health chip", () => {
    expect(healthChip(0).label).toBe("Healthy");
    expect(healthChip(2).label).toBe("Busy");
    expect(healthChip(4).label).toBe("Under load");
  });

  it("describes slow actions in plain language", () => {
    expect(formatSlowActions(null)).toBe("Not available yet");
    expect(formatSlowActions({ slowActions24h: 0 } as RuntimeHealthSnapshot)).toBe("None in the last 24h");
    expect(formatSlowActions({ slowActions24h: 1 } as RuntimeHealthSnapshot)).toBe("1 slow response in 24h");
    expect(formatSlowActions({ slowActions24h: 4 } as RuntimeHealthSnapshot)).toBe("4 slow responses in 24h");
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

  it("groups compressible history, database rows, and filesystem targets", () => {
    const plan = buildSafeCleanupPlan({ categories, extras }, new Map());
    expect(plan.estimatedBytes).toBe(720 * MB);
    expect(plan.groups.map((g) => g.heading)).toEqual([
      "Chats & terminal history",
      "Project database",
      "Temporary & rebuildable files",
      "Obsolete recovery backups",
    ]);
    expect(plan.fsTargets).toHaveLength(3);
    expect(plan.fsBytes).toBe(560 * MB);
    expect(plan.fsGroup?.rows).toHaveLength(2);
    expect(plan.groups.find((group) => group.heading === "Temporary & rebuildable files")?.rows)
      .toEqual([
        { label: "npm", size: "300 MB" },
        { label: "iOS build data", size: "200 MB" },
      ]);
    expect(plan.groups.find((group) => group.heading === "Obsolete recovery backups")?.rows)
      .toEqual([{ label: "Obsolete recovery backup", size: "60.0 MB" }]);
    expect(plan.groups.flatMap((group) => group.rows).some((row) => row.label === "Newest recovery backup")).toBe(false);
    expect(plan.whatHappens.at(-1)).toContain("never touched");
    expect(plan.whatHappens.at(-1)).toContain("newest backup is always kept");
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
