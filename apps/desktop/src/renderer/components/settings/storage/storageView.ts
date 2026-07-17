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
    case "build_release":
    case "caches":
      if (CACHE_SEGMENT.test(p)) return { kind: "rebuildable_cache", path: p };
      if (ADE_TMP_STAGING.test(p)) return { kind: "stale_tmp_staging", path: p };
      if (TMP_STAGING.test(p)) return { kind: "stale_tmp_staging", path: p };
      return null;
    default:
      return null; // chats_history, proof_attachments, database
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
    if (categoryId === "lanes_worktrees") {
      if (item.safety !== "review_first") continue;
    } else if (categoryId !== "recovery_backups") {
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
  review_artifacts: "Saved output from past code reviews.",
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
  /** Quiet inline action verb, or null when the row is protected/pending. */
  actionLabel: string | null;
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
      const actionLabel = isProtected || isPending
        ? null
        : entry.action === "prunable"
          ? "Clean up"
          : entry.action === "compactable"
            ? "Compact now"
            : null;
      return {
        table: entry.table,
        label: entry.label,
        bytes: entry.bytes,
        size: formatBytes(entry.bytes),
        category: entry.category,
        hint: DB_CATEGORY_HINT[entry.category],
        isProtected,
        action: entry.action,
        actionLabel,
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
  "db.review_run_artifacts": "Review artifacts",
  "db.pull_request_snapshots": "Pull request cache",
  "db.core": "Core data",
  "fs.transcripts": "Chat & terminal history",
  "fs.tmp": "Release staging",
  "fs.tmp_staging": "Build staging",
  "fs.recovery_backups": "Recovery backups",
  "fs.cache": "Caches",
  "fs.ios_derived_data": "iOS build cache",
  "fs.storage_doctor_journal": "Maintenance journal",
  "fs.artifacts": "Proof & recordings",
  "fs.attachments": "Attachments",
  "fs.worktrees": "Lane worktrees",
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

/** Database-size samples from doctor runs, chronological, positive-valued only. */
export function dbSizeSamples(extras: StorageSnapshotExtras | undefined): DbSizeSample[] {
  const journal = extras?.maintenance?.journal ?? [];
  const out: DbSizeSample[] = [];
  for (const run of journal) {
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

/** Resident memory of the ADE background service (ade-runtime role), in bytes, or null. */
export function daemonMemoryBytes(usage: AppResourceUsageSnapshot | null): number | null {
  const roleUsage = usage?.roleUsage;
  if (!roleUsage) return null;
  let mb = 0;
  let found = false;
  for (const entry of roleUsage) {
    if (entry.role !== "ade-runtime") continue;
    if (typeof entry.memoryMB === "number" && Number.isFinite(entry.memoryMB)) {
      mb += entry.memoryMB;
      found = true;
    }
  }
  return found ? mb * 1024 * 1024 : null;
}

export type HealthTone = "good" | "elevated" | "busy";

/** Overall health chip derived from the resource-pressure level (0..4). */
export function healthChip(level: ResourcePressureLevel): { label: string; tone: HealthTone } {
  if (level >= 3) return { label: "Under load", tone: "busy" };
  if (level === 2) return { label: "Busy", tone: "elevated" };
  return { label: "Healthy", tone: "good" };
}

/** Plain sentence for the slow-actions tile. */
export function formatSlowActions(health: RuntimeHealthSnapshot | null): string {
  if (!health) return "Not available yet";
  const n = health.slowActions24h;
  if (!Number.isFinite(n) || n <= 0) return "None in the last 24h";
  return `${n} slow ${n === 1 ? "response" : "responses"} in 24h`;
}

// ---- Safe-cleanup plan -----------------------------------------------------

export type SafeCleanupGroup = {
  heading: string;
  rows: Array<{ label: string; size: string }>;
};

export type SafeCleanupPlan = {
  /** Filesystem targets used only for the legacy fallback (cleanup-by-target). */
  fsTargets: StorageCleanupTarget[];
  /** Sum of the filesystem-safe targets' sizes (the legacy fallback reclaim). */
  fsBytes: number;
  /** Grouped, itemized preview of what the safe cleanup will reclaim. */
  groups: SafeCleanupGroup[];
  /** Just the filesystem group, for the legacy fallback preview. */
  fsGroup: SafeCleanupGroup | null;
  /** Plain-language "what happens" lines. */
  whatHappens: string[];
  /** Approximate total the doctor will reclaim. */
  estimatedBytes: number;
};

/**
 * Assemble the itemized "Clean up safely" plan from the snapshot's extras. Only
 * meaningful when `extras.safeReclaimableBytes` is positive (the primary action
 * is otherwise hidden). Groups the reclaimable database rows and compressible
 * history, and collects the filesystem-safe targets for the legacy fallback path.
 */
export function buildSafeCleanupPlan(
  snapshot: { categories: StorageCategorySnapshot[]; extras?: StorageSnapshotExtras },
  laneIdByKey: Map<string, string>,
): SafeCleanupPlan {
  const extras = snapshot.extras;
  const estimatedBytes = safeReclaimableBytes(extras);

  const groups: SafeCleanupGroup[] = [];
  const whatHappens: string[] = [];

  // Compressible chat & terminal history.
  const chats = snapshot.categories.find((c) => c.id === "chats_history");
  const compressible = chats?.compressibleBytes ?? 0;
  if (compressible > 0) {
    groups.push({
      heading: "Chats & terminal history",
      rows: [{ label: "Older history, compressed in place", size: formatBytes(compressible) }],
    });
    whatHappens.push("Compress older chat and terminal history — nothing is lost.");
  }

  // Reclaimable database rows (prunable/compactable).
  const dbRows = (extras?.dbBreakdown ?? [])
    .filter((entry) => entry.action === "prunable" || entry.action === "compactable")
    .sort((a, b) => b.bytes - a.bytes)
    .map((entry) => ({ label: entry.label, size: formatBytes(entry.bytes) }));
  if (dbRows.length > 0) {
    groups.push({ heading: "Project database", rows: dbRows });
    whatHappens.push("Clean up data ADE keeps but no longer needs.");
  }

  // Filesystem-safe targets (caches + build/release staging) for the fallback path.
  const fsTargets: StorageCleanupTarget[] = [];
  const fsRows: Array<{ label: string; size: string }> = [];
  let fsBytes = 0;
  for (const category of snapshot.categories) {
    if (category.id !== "caches" && category.id !== "build_release") continue;
    for (const entry of cleanableEntries(category.id, category, laneIdByKey)) {
      fsTargets.push(entry.target);
      fsRows.push({ label: entry.item.label, size: formatBytes(entry.item.bytes) });
      fsBytes += entry.item.bytes;
    }
  }
  const fsGroup: SafeCleanupGroup | null = fsRows.length > 0
    ? { heading: "Temporary & rebuildable files", rows: fsRows }
    : null;
  if (fsGroup) groups.push(fsGroup);
  if (fsGroup || estimatedBytes > 0) {
    whatHappens.push("Remove temporary and rebuildable files ADE recreates on demand.");
  }

  whatHappens.push("Your chats, projects, and active lanes are never touched, and your newest backup is always kept.");

  return { fsTargets, fsBytes, groups, fsGroup, whatHappens, estimatedBytes };
}
