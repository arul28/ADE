import type {
  DbBreakdownCategory,
  DbBreakdownEntry,
  MaintenanceAction,
  MaintenanceRunReport,
  RuntimeHealthSnapshot,
  StorageCategoryId,
  StorageCategorySnapshot,
  StorageCleanupTarget,
  StorageItem,
  StorageSafety,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import type { AppResourceUsageSnapshot } from "../../../../shared/types";
import { DELETED_LANE_CHATS_ITEM_ID } from "../../../../shared/types/storage";
import type { ResourcePressureLevel } from "../../../lib/resourcePressure";
import { COLORS } from "../../lanes/laneDesignTokens";
import { formatBytes } from "../../../lib/format";
export { formatBytes } from "../../../lib/format";

/**
 * Presentation metadata for the storage dashboard. This module holds only pure
 * helpers so the mapping from the storage snapshot to cleanup targets — the part
 * that must stay correct as the backend evolves — is unit-testable without a DOM.
 */

export type CategoryMeta = {
  /** Human display name shown as the card title. */
  name: string;
  /** One-line plain-language description. No internal jargon. */
  description: string;
  /** Distinct hue used for this category's segment and swatch. */
  hue: string;
};

// Curated, muted category hues. Distinct enough to read as separate segments,
// desaturated enough to look intentional rather than a rainbow. These are data
// colors (legend-backed), not semantic status colors.
export const CATEGORY_META: Record<StorageCategoryId, CategoryMeta> = {
  chats_history: {
    name: "Chats & terminal history",
    description: "Transcripts of your chats and terminal sessions.",
    hue: "#8b7bf0",
  },
  lanes_worktrees: {
    name: "Lanes & worktrees",
    description: "Working copies ADE keeps for each lane.",
    hue: "#4aa8e0",
  },
  build_release: {
    name: "Build & release files",
    description: "Leftover staging from building and releasing your app.",
    hue: "#e0a44a",
  },
  caches: {
    name: "Caches",
    description: "Rebuildable data ADE recreates whenever it needs it.",
    hue: "#43b3a0",
  },
  proof_attachments: {
    name: "Proof & attachments",
    description: "Screenshots, recordings, and files you've attached.",
    hue: "#d071b8",
  },
  recovery_backups: {
    name: "Recovery backups",
    description: "Snapshots ADE saved before making risky changes.",
    hue: "#7b86e0",
  },
  database: {
    name: "Project database",
    description: "Your project's live data.",
    hue: "#8a8f9c",
  },
};

// Order the cards deliberately: the largest, most actionable categories first,
// protected data last. Lanes leads because it is the feature users came for.
export const CATEGORY_ORDER: StorageCategoryId[] = [
  "lanes_worktrees",
  "chats_history",
  "caches",
  "build_release",
  "proof_attachments",
  "recovery_backups",
  "database",
];

export type SafetyMeta = { label: string; color: string };

export const SAFETY_META: Record<StorageSafety, SafetyMeta> = {
  safe_to_remove: { label: "Safe to remove", color: COLORS.success },
  compressible: { label: "Can be compressed", color: COLORS.info },
  review_first: { label: "Review first", color: COLORS.warning },
  protected: { label: "Protected", color: COLORS.textMuted },
};

/** Basename of a path without pulling in node's path module in the renderer. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

const CACHE_SEGMENT = /[\\/]\.ade[\\/]cache[\\/]/;
const TMP_STAGING = /[\\/]ade-[^\\/]*[\\/]?$/;
// A direct child of the project-relative `.ade/tmp` release-staging dir (e.g.
// `.ade/tmp/ios-testflight-123`). The backend validates these under the same
// `stale_tmp_staging` kind as the system-temp `ade-*` dirs; a deeper path (a
// grandchild) intentionally does not match.
const ADE_TMP_STAGING = /[\\/]\.ade[\\/]tmp[\\/][^\\/]+$/;

/**
 * Resolve the cleanup target for a single item, or null when it cannot be safely
 * removed through the storage API. The kind is derived from the item's path (not
 * just its category) because a category can hold paths the backend validates
 * under different kinds — e.g. iOS build data lives under `.ade/cache`, so it is
 * a rebuildable cache even though it appears under "Build & release files".
 *
 * `laneIdByKey` maps a worktree directory name to its lane id; archived lanes
 * require the real lane id, which the snapshot item does not carry.
 */
export function buildCleanupTarget(
  categoryId: StorageCategoryId,
  item: StorageItem,
  laneIdByKey: Map<string, string>,
): StorageCleanupTarget | null {
  const p = item.path;
  switch (categoryId) {
    case "lanes_worktrees": {
      if (item.laneStatus === "orphaned") return { kind: "orphaned_worktree", path: p };
      if (item.laneStatus === "archived") {
        const laneId = laneIdByKey.get(baseName(p));
        return laneId ? { kind: "archived_lane_worktree", laneId, path: p } : null;
      }
      return null; // active worktrees are protected
    }
    case "recovery_backups":
      return { kind: "recovery_backup", path: p };
    case "proof_attachments":
      return { kind: "proof_attachments", path: p };
    case "build_release":
    case "caches":
      if (CACHE_SEGMENT.test(p)) return { kind: "rebuildable_cache", path: p };
      if (ADE_TMP_STAGING.test(p)) return { kind: "stale_tmp_staging", path: p };
      if (TMP_STAGING.test(p)) return { kind: "stale_tmp_staging", path: p };
      return null;
    case "chats_history":
      // History is compressed, never removed, except chats whose lane is gone.
      return item.id === DELETED_LANE_CHATS_ITEM_ID ? { kind: "deleted_lane_chats", path: p } : null;
    default:
      return null; // database
  }
}

export type CleanableEntry = { item: StorageItem; target: StorageCleanupTarget };

/**
 * The items within a category that we can offer a working cleanup action for.
 * Excludes protected/compressible items and anything whose path we can't map to
 * a valid target, so we never present a Remove button that is doomed to block.
 */
export function cleanableEntries(
  categoryId: StorageCategoryId,
  category: StorageCategorySnapshot,
  laneIdByKey: Map<string, string>,
): CleanableEntry[] {
  const out: CleanableEntry[] = [];
  for (const item of category.items) {
    const target = buildCleanupTarget(categoryId, item, laneIdByKey);
    if (!target) continue;
    if (categoryId === "lanes_worktrees" || categoryId === "chats_history") {
      if (item.safety !== "review_first") continue;
    } else if (categoryId !== "recovery_backups" && categoryId !== "proof_attachments") {
      // Proof is `review_first` by design — it is user data, not derived data.
      // It is removable on purpose, just never as part of a bulk "safe" sweep
      // (see `buildSafeCleanupPlan`, which only considers caches/build files).
      if (item.safety !== "safe_to_remove") continue;
    }
    out.push({ item, target });
  }
  return out;
}

/** Split lane items into their three display groups, largest first within each. */
export function groupLaneItems(items: StorageItem[]): {
  active: StorageItem[];
  archived: StorageItem[];
  orphaned: StorageItem[];
} {
  const active: StorageItem[] = [];
  const archived: StorageItem[] = [];
  const orphaned: StorageItem[] = [];
  for (const item of items) {
    if (item.laneStatus === "archived") archived.push(item);
    else if (item.laneStatus === "orphaned") orphaned.push(item);
    else active.push(item);
  }
  return { active, archived, orphaned };
}

// ===========================================================================
// Diagnostics & maintenance view-model (overhaul)
//
// These pure helpers turn the optional `StorageSnapshotExtras` (dbBreakdown,
// maintenance journal, policy chips, reclaimable total) and the machine-level
// resource/health snapshots into display-ready shapes. Every helper degrades to
// a sensible "not available" value when its source is missing, so the UI can be
// rendered against an older daemon that never sends `extras`.
// ===========================================================================

/** Approximate size label, e.g. "~1.2 GB". Used for estimates the doctor will reclaim. */
export function formatApproxBytes(bytes: number): string {
  return `~${formatBytes(bytes)}`;
}

/** The daemon-provided safe reclaim estimate, clamped to a positive number. */
export function safeReclaimableBytes(extras: StorageSnapshotExtras | undefined): number {
  const n = extras?.safeReclaimableBytes;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The policy chip string for a category (e.g. "Auto-cleans · 7 days"), or undefined. */
export function categoryPolicyChip(
  extras: StorageSnapshotExtras | undefined,
  categoryId: StorageCategoryId,
): string | undefined {
  const chip = extras?.policyChips?.[categoryId];
  return typeof chip === "string" && chip.trim().length > 0 ? chip : undefined;
}

// ---- Project database breakdown -------------------------------------------

/** Plain-language framing for each internal database category. No jargon. */
export const DB_CATEGORY_HINT: Record<DbBreakdownCategory, string> = {
  webhooks: "History of incoming events from your automations.",
  sync_bookkeeping: "Records ADE keeps to sync your work across devices.",
  pr_cache: "A local copy of pull request details, refetched when needed.",
  core: "Your project's live data — chats, lanes, and settings.",
};

export type DbBreakdownRow = {
  table: string;
  label: string;
  bytes: number;
  size: string;
  category: DbBreakdownCategory;
  hint: string;
  /** Core data is framed as protected and never gets a destructive action. */
  isProtected: boolean;
  action: DbBreakdownEntry["action"];
  /**
   * "Clean up safely" trims this table (expired rows, sync tombstones). There
   * is no per-row button: the only database action is the whole cleanup, and
   * per-row "Clean up" / "Compact now" buttons that both ran it misled.
   */
  trimmedByCleanup: boolean;
  /** Waiting for a safe moment to compact (peers mid-sync); shows a tooltip, no action. */
  isPending: boolean;
};

/** Largest-first, display-ready rows for the project database card. */
export function dbBreakdownRows(entries: DbBreakdownEntry[] | undefined): DbBreakdownRow[] {
  if (!entries || entries.length === 0) return [];
  return [...entries]
    .filter((entry) => entry.bytes > 0 || entry.category === "core")
    .sort((a, b) => b.bytes - a.bytes)
    .map((entry) => {
      const isProtected = entry.category === "core";
      const isPending = entry.action === "compaction_pending";
      const trimmedByCleanup = !isProtected && (entry.action === "prunable" || entry.action === "compactable");
      return {
        table: entry.table,
        label: entry.label,
        bytes: entry.bytes,
        size: formatBytes(entry.bytes),
        category: entry.category,
        hint: DB_CATEGORY_HINT[entry.category],
        isProtected,
        action: entry.action,
        trimmedByCleanup,
        isPending,
      };
    });
}

/** Copy shown in the "waiting to compact" tooltip. Never references sync internals. */
export const DB_COMPACTION_PENDING_HINT =
  "Kept while devices stay in sync. Safe to leave — a future update will reclaim it.";

// ---- Maintenance journal ---------------------------------------------------

/**
 * Friendly name for a ledger id, keyed by the exact ids declared in
 * `storageLedger.ts` (and used verbatim as maintenance-action `ledgerId`s).
 * Unknown ids fall back to a title-cased last segment so an entry we haven't
 * labelled still reads cleanly and never leaks a raw identifier.
 */
const LEDGER_LABELS: Record<string, string> = {
  "db.automation_ingress_events": "Webhook history",
  "db.operations_crsql": "Sync bookkeeping",
  "db.pull_request_snapshots": "Pull request cache",
  "db.event_logs": "Event history",
  "db.core": "Core data",
  "fs.transcripts": "Chat & terminal history",
  "fs.transcript_duplicates": "Duplicate chat copies",
  "cache.search_index": "Search index",
  "fs.provider_sessions": "Provider session copies",
  "fs.tmp": "Release staging",
  "fs.tmp_staging": "Build staging",
  "fs.recovery_backups": "Recovery backups",
  "fs.cache": "Caches",
  "fs.ios_derived_data": "iOS build cache",
  "fs.storage_doctor_journal": "Maintenance journal",
  "fs.artifacts": "Proof & recordings",
  "fs.attachments": "Attachments",
  "fs.worktrees": "Lane worktrees",
  "fs.lane_build_output": "Build output in idle lanes",
};

export function ledgerLabel(ledgerId: string): string {
  const known = LEDGER_LABELS[ledgerId];
  if (known) return known;
  const segment = ledgerId.split(/[.:/]/).pop() ?? ledgerId;
  const words = segment.replace(/[_-]+/g, " ").trim();
  if (!words) return "Maintenance";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One humanized line per maintenance action, largest reclaim first. */
export function maintenanceActionLines(
  report: MaintenanceRunReport,
): Array<{ ledgerId: string; label: string; detail: string; failed: boolean }> {
  return [...report.actions]
    .sort((a, b) => b.bytesReclaimed - a.bytesReclaimed)
    .map((action) => ({
      ledgerId: action.ledgerId,
      label: ledgerLabel(action.ledgerId),
      detail: maintenanceActionDetail(action),
      failed: Boolean(action.error),
    }));
}

/** Honest one-line outcome for a maintenance report, including partial failures. */
export function maintenanceOutcome(report: MaintenanceRunReport): { message: string; failed: boolean } {
  const reclaimed = typeof report.reclaimedBytes === "number" && Number.isFinite(report.reclaimedBytes)
    ? Math.max(0, report.reclaimedBytes)
    : 0;
  const failed = report.actions.some((action) => Boolean(action.error));
  if (failed) {
    return {
      message: reclaimed > 0
        ? `Reclaimed ${formatBytes(reclaimed)}, but some cleanup steps couldn't finish`
        : "Some cleanup steps couldn't finish",
      failed: true,
    };
  }
  return {
    message: reclaimed > 0 ? `Reclaimed ${formatBytes(reclaimed)}` : "Storage is already tidy",
    failed: false,
  };
}

function maintenanceActionDetail(action: MaintenanceAction): string {
  if (action.error) return "couldn't finish";
  if (action.skippedReason) return "nothing to do";
  if (action.bytesReclaimed > 0) return `reclaimed ${formatBytes(action.bytesReclaimed)}`;
  if (action.itemsAffected > 0) {
    return `${action.itemsAffected} ${action.itemsAffected === 1 ? "item" : "items"}`;
  }
  return actionVerbPast(action.kind);
}

function actionVerbPast(kind: MaintenanceAction["kind"]): string {
  switch (kind) {
    case "compress":
      return "compressed";
    case "compact":
      return "compacted";
    case "prune":
    case "delete":
      return "cleaned up";
    case "vacuum":
      return "reclaimed space";
    case "checkpoint":
      return "tidied up";
    default:
      return "done";
  }
}

/**
 * A friendly clock label for a run timestamp: "Today 03:12", "Yesterday 03:12",
 * a weekday within a week, else "Jul 12 03:12". `now` is injectable for tests.
 */
export function formatRunClock(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDelta = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDelta <= 0) return `Today ${time}`;
  if (dayDelta === 1) return `Yesterday ${time}`;
  if (dayDelta < 7) return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** Headline for a maintenance run, e.g. "Yesterday 03:12 · reclaimed 481 MB". */
export function maintenanceHeadline(report: MaintenanceRunReport, now?: Date): string {
  const when = formatRunClock(report.finishedAt || report.startedAt, now);
  const reclaimed = report.reclaimedBytes > 0
    ? `reclaimed ${formatBytes(report.reclaimedBytes)}`
    : "nothing to reclaim";
  return when ? `${when} · ${reclaimed}` : reclaimed;
}

/** Recent runs, newest first, capped for display. */
export function journalEntries(
  extras: StorageSnapshotExtras | undefined,
  limit = 8,
): MaintenanceRunReport[] {
  const journal = extras?.maintenance?.journal ?? [];
  return [...journal]
    .sort((a, b) => runTime(b) - runTime(a))
    .slice(0, Math.max(0, limit));
}

/** The most recent run (prefer the explicit lastRun, else the newest journal entry). */
export function lastMaintenanceRun(
  extras: StorageSnapshotExtras | undefined,
): MaintenanceRunReport | null {
  return extras?.maintenance?.lastRun ?? journalEntries(extras, 1)[0] ?? null;
}

function runTime(report: MaintenanceRunReport): number {
  const ts = Date.parse(report.finishedAt || report.startedAt);
  return Number.isNaN(ts) ? 0 : ts;
}

// ---- Database-size trend & sparkline --------------------------------------

export type DbSizeSample = { ts: string; bytes: number };

/**
 * Database-size samples from cleanup runs, chronological, positive-valued
 * only. Only runs that measured the database the way the snapshot does (main
 * file plus -wal and -shm) count: older runs measured the main file alone, and
 * mixing the two made a cleanup look like the database grew.
 */
export function dbSizeSamples(extras: StorageSnapshotExtras | undefined): DbSizeSample[] {
  const journal = extras?.maintenance?.journal ?? [];
  const out: DbSizeSample[] = [];
  for (const run of journal) {
    if (run.dbSizeDefinition !== "files") continue;
    const bytes = run.dbSizeBytes;
    const ts = run.finishedAt || run.startedAt;
    if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 && ts && !Number.isNaN(Date.parse(ts))) {
      out.push({ ts, bytes });
    }
  }
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return out;
}

export type Trend = "down" | "up" | "flat";

/** Trend of the last two database samples, or null when there aren't two. */
export function dbSizeTrend(samples: DbSizeSample[]): Trend | null {
  if (samples.length < 2) return null;
  const prev = samples[samples.length - 2].bytes;
  const last = samples[samples.length - 1].bytes;
  if (prev <= 0) return null;
  const ratio = last / prev;
  if (ratio < 0.99) return "down";
  if (ratio > 1.01) return "up";
  return "flat";
}

/** Normalized polyline points (0..1 in both axes, y flipped for SVG) for a sparkline. */
export function sparklinePoints(
  samples: DbSizeSample[],
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  if (samples.length === 0) return [];
  if (samples.length === 1) {
    return [{ x: 0, y: height / 2 }, { x: width, y: height / 2 }];
  }
  const values = samples.map((s) => s.bytes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (samples.length - 1);
  return samples.map((sample, index) => ({
    x: index * step,
    y: height - ((sample.bytes - min) / span) * height,
  }));
}

// ---- Machine health --------------------------------------------------------

/**
 * Resident memory of ADE's background service processes (the brain and any
 * other ADE runtime this desktop runs; never the agents, shells or tools they
 * start), with how many processes that is. Null when not sampled.
 */
export function serviceMemory(usage: AppResourceUsageSnapshot | null): { bytes: number; processCount: number } | null {
  const roleUsage = usage?.roleUsage;
  if (!roleUsage) return null;
  let mb = 0;
  let processCount = 0;
  let found = false;
  for (const entry of roleUsage) {
    if (entry.role !== "ade-runtime") continue;
    if (typeof entry.memoryMB === "number" && Number.isFinite(entry.memoryMB)) {
      mb += entry.memoryMB;
      processCount += Math.max(0, entry.processCount);
      found = true;
    }
  }
  return found && processCount > 0 ? { bytes: mb * 1024 * 1024, processCount } : null;
}

export type LoadTone = "ok" | "warn" | "crit";

/**
 * How loaded this computer is right now, from the resource-pressure level
 * (0..4). It is an instant reading of CPU and memory, so it is called "Load",
 * not "Health".
 */
export function loadChip(level: ResourcePressureLevel): { label: string; tone: LoadTone } {
  if (level >= 3) return { label: "Heavy", tone: "crit" };
  if (level === 2) return { label: "Busy", tone: "warn" };
  return { label: "Light", tone: "ok" };
}

/** Slow and failed background-service calls over 24 h, kept apart. */
export function responseHealth(health: RuntimeHealthSnapshot | null): {
  slow: number;
  failed: number | null;
  p95Ms: number | null;
} | null {
  if (!health) return null;
  const slow = Number.isFinite(health.slowActions24h) ? Math.max(0, health.slowActions24h) : 0;
  const failed = typeof health.failedActions24h === "number" && Number.isFinite(health.failedActions24h)
    ? Math.max(0, health.failedActions24h)
    : null;
  return { slow, failed, p95Ms: slow > 0 ? health.slowActionP95Ms : null };
}

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

// ---- Cleanup history ---------------------------------------------------------

export type CleanupRunParts = {
  /** Files removed (staging, caches, backups, proof, leftover lane folders). */
  files: number;
  /** Database rows pruned, tombstones compacted, space vacuumed. */
  database: number;
  /** Chat and terminal history compression savings. */
  history: number;
  total: number;
};

/** What one run freed, by kind. `total` is the run's own reclaimed figure. */
export function cleanupRunParts(run: MaintenanceRunReport): CleanupRunParts {
  let files = 0;
  let database = 0;
  let history = 0;
  for (const action of run.actions) {
    const bytes = Math.max(0, action.bytesReclaimed);
    if (bytes <= 0) continue;
    if (action.ledgerId === "fs.transcripts") history += bytes;
    else if (action.ledgerId.startsWith("db.")) database += bytes;
    else files += bytes;
  }
  const total = Number.isFinite(run.reclaimedBytes) ? Math.max(0, run.reclaimedBytes) : files + database + history;
  return { files, database, history, total };
}

/** "files 392 MB · database 12 MB · history 1.6 MB", parts with bytes only. */
export function cleanupPartsLine(parts: CleanupRunParts): string {
  const out: string[] = [];
  if (parts.files > 0) out.push(`files ${formatBytes(parts.files)}`);
  if (parts.database > 0) out.push(`database ${formatBytes(parts.database)}`);
  if (parts.history > 0) out.push(`history ${formatBytes(parts.history)}`);
  return out.join(" · ");
}

// ---- Rows ------------------------------------------------------------------

export type GroupedRow = { label: string; count: number; bytes: number };

/**
 * Rows with the same label become one row with a count and a total, largest
 * first, and rows with nothing to free are dropped. A dozen "Release and build
 * staging · 0 B" rows say less than one "Release and build staging (12)".
 */
export function groupRowsByLabel(rows: ReadonlyArray<{ label: string; bytes: number }>): GroupedRow[] {
  const byLabel = new Map<string, GroupedRow>();
  for (const row of rows) {
    if (!(row.bytes > 0)) continue;
    const existing = byLabel.get(row.label);
    if (existing) {
      existing.count += 1;
      existing.bytes += row.bytes;
    } else {
      byLabel.set(row.label, { label: row.label, count: 1, bytes: row.bytes });
    }
  }
  return [...byLabel.values()].sort((a, b) => b.bytes - a.bytes);
}

/** A size that may be a lower bound: "≥ 4.1 GB" when not fully measured. */
export function formatMeasuredBytes(bytes: number, partial: boolean | undefined): string {
  if (!partial) return formatBytes(bytes);
  return bytes > 0 ? `≥ ${formatBytes(bytes)}` : "Not measured";
}

// ---- Charts ----------------------------------------------------------------

export type ChartSeries = { id: string; label: string; bytes: number; partial: boolean; members: string[] };

/**
 * ADE's data by category as at most four series plus "Other" (the chart
 * rule in docs/design/visual-language.md), largest first, empty ones dropped.
 */
export function categorySeries(categories: StorageCategorySnapshot[], max = 4): ChartSeries[] {
  const present = categories
    .filter((category) => category.bytes > 0 || category.partial)
    .sort((a, b) => b.bytes - a.bytes);
  const head = present.length > max + 1 ? present.slice(0, max) : present;
  const tail = present.length > max + 1 ? present.slice(max) : [];
  const series: ChartSeries[] = head.map((category) => ({
    id: category.id,
    label: CATEGORY_META[category.id].name,
    bytes: category.bytes,
    partial: Boolean(category.partial),
    members: [CATEGORY_META[category.id].name],
  }));
  if (tail.length > 0) {
    series.push({
      id: "other",
      label: "Other",
      bytes: tail.reduce((sum, category) => sum + category.bytes, 0),
      partial: tail.some((category) => category.partial),
      members: tail.map((category) => CATEGORY_META[category.id].name),
    });
  }
  return series;
}

export type LaneBar = { id: string; label: string; bytes: number; partial: boolean; status: StorageItem["laneStatus"]; count: number };

/** The largest lanes as bars, the rest folded into one "Other" bar. */
export function laneBars(items: StorageItem[], max = 6): LaneBar[] {
  const measured = items
    .filter((item) => item.bytes > 0 || item.partial)
    .sort((a, b) => b.bytes - a.bytes);
  const head = measured.length > max + 1 ? measured.slice(0, max) : measured;
  const tail = measured.length > max + 1 ? measured.slice(max) : [];
  const bars: LaneBar[] = head.map((item) => ({
    id: item.id,
    label: item.label,
    bytes: item.bytes,
    partial: Boolean(item.partial),
    status: item.laneStatus,
    count: 1,
  }));
  if (tail.length > 0) {
    bars.push({
      id: "other",
      label: `${tail.length} other ${tail.length === 1 ? "lane" : "lanes"}`,
      bytes: tail.reduce((sum, item) => sum + item.bytes, 0),
      partial: tail.some((item) => item.partial),
      status: undefined,
      count: tail.length,
    });
  }
  return bars;
}

/** Free-space meter level: amber under 20% free, red under 5% (the Usage headroom rule). */
export function freeSpaceLevel(freeBytes: number, totalBytes: number): "warn" | "crit" | undefined {
  if (!(totalBytes > 0)) return undefined;
  const percentFree = (freeBytes / totalBytes) * 100;
  if (percentFree <= 5) return "crit";
  if (percentFree <= 20) return "warn";
  return undefined;
}

// ---- Safe-cleanup plan -----------------------------------------------------

export type SafeCleanupPlan = {
  /** The files "Clean up safely" removes, deduplicated (no target inside another). */
  fsTargets: StorageCleanupTarget[];
  /**
   * What those files take, by kind: one row per label with a count. The rows
   * sum to `estimatedBytes`, the number on the button.
   */
  rows: GroupedRow[];
  estimatedBytes: number;
  /** Some of those sizes are lower bounds (the scan ran out of budget). */
  partial: boolean;
  /**
   * The rest of the run, whose savings are only known once it has run, so no
   * bytes are promised for it: history compression, database trims, and the
   * idle-lane check that can archive lanes.
   */
  alsoRuns: string[];
  /** What is never touched. */
  keeps: string;
};

function isSameOrInside(parent: string, candidate: string): boolean {
  const a = parent.replace(/[\\/]+$/, "");
  const b = candidate.replace(/[\\/]+$/, "");
  return a === b || b.startsWith(`${a}/`) || b.startsWith(`${a}\\`);
}

/**
 * Exactly what "Clean up safely" does, itemized: the rebuildable caches,
 * old staging and obsolete recovery backups it removes (after a fresh preview
 * the person confirms), then, when the maintenance run is available, the work
 * it runs after.
 */
export function buildSafeCleanupPlan(
  snapshot: {
    categories: StorageCategorySnapshot[];
    extras?: StorageSnapshotExtras;
    lifecycle?: { policy: { cleanupIntervalHours: number; cleanBuildOutputAfterDays?: number } };
  },
  laneIdByKey: Map<string, string>,
  opts: { maintenance: boolean } = { maintenance: true },
): SafeCleanupPlan {
  const candidates: Array<{ item: StorageItem; target: StorageCleanupTarget }> = [];
  for (const category of snapshot.categories) {
    if (category.id !== "caches" && category.id !== "build_release") continue;
    candidates.push(...cleanableEntries(category.id, category, laneIdByKey));
  }

  // Independently enforce the doctor's keepLatest: 1 policy instead of
  // trusting the snapshot's safety classification: the newest backup is
  // never offered, whatever the snapshot says.
  const recoveryBackups = snapshot.categories
    .find((category) => category.id === "recovery_backups")
    ?.items ?? [];
  const newestBackup = recoveryBackups.reduce<StorageItem | null>((newest, item) => {
    if (!newest) return item;
    const newestModifiedAt = newest.lastModifiedAt ? Date.parse(newest.lastModifiedAt) : Number.NEGATIVE_INFINITY;
    const itemModifiedAt = item.lastModifiedAt ? Date.parse(item.lastModifiedAt) : Number.NEGATIVE_INFINITY;
    return itemModifiedAt > newestModifiedAt ? item : newest;
  }, null);
  for (const item of recoveryBackups) {
    if (item === newestBackup || item.safety !== "safe_to_remove") continue;
    candidates.push({ item: { ...item, label: "Old recovery backup" }, target: { kind: "recovery_backup", path: item.path } });
  }

  // A target inside another target is removed with it; listing both would
  // count its bytes twice.
  const byDepth = [...candidates].sort((a, b) => a.target.path.length - b.target.path.length);
  const kept: typeof candidates = [];
  for (const entry of byDepth) {
    if (kept.some((other) => isSameOrInside(other.target.path, entry.target.path))) continue;
    kept.push(entry);
  }

  const rows = groupRowsByLabel(kept.map((entry) => ({ label: entry.item.label, bytes: entry.item.bytes })));
  const estimatedBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const partial = kept.some((entry) => entry.item.partial);

  const alsoRuns: string[] = [];
  if (opts.maintenance) {
    const lifecycle = snapshot.lifecycle;
    if (lifecycle && lifecycle.policy.cleanupIntervalHours > 0) {
      alsoRuns.push("Checks for idle lanes first and archives the ones your Archive idle lanes rules allow. Their branches, chats and files are kept.");
    }
    const buildOutputDays = lifecycle?.policy.cleanBuildOutputAfterDays ?? 0;
    if (buildOutputDays > 0) {
      alsoRuns.push(`Removes build output, like node_modules and dist, from lanes idle ${buildOutputDays} ${buildOutputDays === 1 ? "day" : "days"}. A reinstall or build brings it back.`);
    }
    const compressible = snapshot.categories.find((c) => c.id === "chats_history")?.compressibleBytes ?? 0;
    if (compressible > 0) {
      alsoRuns.push(`Compresses ${formatBytes(compressible)} of old chat and terminal history. Nothing is lost.`);
    }
    const trimmed = (snapshot.extras?.dbBreakdown ?? [])
      .filter((entry) => entry.action === "prunable" || entry.action === "compactable")
      .map((entry) => entry.label);
    alsoRuns.push(trimmed.length > 0
      ? `Trims database data ADE no longer needs (${trimmed.join(", ")}) and returns free space to the disk.`
      : "Returns free database space to the disk when the database is fragmented.");
  }

  return {
    fsTargets: kept.map((entry) => entry.target),
    rows,
    estimatedBytes,
    partial,
    alsoRuns,
    keeps: "Your chats, your lanes' own files and the newest recovery backup are never touched.",
  };
}
