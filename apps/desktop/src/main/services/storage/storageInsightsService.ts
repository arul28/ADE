import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  DbBreakdownEntry,
  MaintenanceAction,
  MaintenanceActionKind,
  MaintenanceRunReport,
  MaintenanceTrigger,
  StorageCategoryId,
  StorageCategorySnapshot,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageCompressionResult,
  StorageItem,
  StorageSafety,
  StorageSnapshot,
  StorageSnapshotExtras,
} from "../../../shared/types/storage";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsCaptureResult,
} from "../../../shared/types/productAnalytics";
import type { LaneCleanupConfig } from "../../../shared/types/config";
import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { runQuickCheck } from "../state/kvDb";
import { readLastFailure } from "../runtime/lastFailureStore";
import { isEnoentError } from "../shared/utils";
import type { DiskPressureMonitor } from "./diskPressure";
import {
  COMPRESSION_MIN_AGE_MS,
  createHistoryCompressor,
  type CompressionRoots,
  type CompressionSweepSummary,
} from "./historyCompression";
import { deriveSyncBookkeepingAction, mapDbBreakdown } from "./storageDbBreakdown";
import { appendMaintenanceJournal, readMaintenanceJournal } from "./storageMaintenanceJournal";
import { deriveCategoryPolicyChips } from "./storageLedger";
import { readVolumeSpace } from "./volume";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_SCAN_ENTRY_LIMIT = 200_000;
const DEFAULT_SCAN_BUDGET_MS = 20_000;
const WALK_CONCURRENCY = 8;
const MAX_CATEGORY_ITEMS = 50;
const STALE_AGE_MS = 7 * 24 * 60 * 60_000;
const COMPRESSIBLE_AGE_MS = COMPRESSION_MIN_AGE_MS;
const RECOVERY_BACKUP_PATTERN = /(?:\.pre-crsqlite-w1\.bak|\.recovery-.*\.bak)$/;
const HISTORY_SWEEP_START_DELAY_MS = 10 * 60_000;
const HISTORY_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const MAINTENANCE_JOURNAL_FILENAME = "storage-doctor-journal.json";
// One completed maintenance run per project per 20 h reaches PostHog; the
// storage doctor runs daily, so the dedupe interval collapses repeat runs
// (e.g. daily + a manual "Clean up now") into a single analytics event.
const MAINTENANCE_ANALYTICS_MIN_INTERVAL_MS = 20 * 60 * 60_000;
const VACUUM_FREELIST_THRESHOLD = 0.2;

/** Injected product-analytics capture. Structurally matches the shared service. */
export type StorageDoctorAnalyticsCapture = (
  input: ProductAnalyticsCapture,
) => ProductAnalyticsCaptureResult | void;

type LaneLifecycleBackend = {
  list: (options: { includeArchived: boolean; includeStatus: boolean }) => Promise<Array<{
    id: string;
    laneType: "primary" | "worktree" | "attached";
    isEditProtected: boolean;
    status: { dirty: boolean };
  }>>;
  getReclaimRisk: (laneId: string) => Promise<{
    dirty: boolean;
    activeChatCount: number;
    activePtyCount: number;
    activeWatcherCount: number;
    blockedReasons: Array<{ code: string }>;
  }>;
  archive: (args: { laneId: string }) => Promise<void>;
};

type LaneCleanupConfigReader = {
  get: () => { effective: { laneCleanup?: LaneCleanupConfig } };
};

type LaneRow = {
  id: string;
  name: string;
  worktree_path: string;
  archived_at: string | null;
  created_at: string;
  lane_type: string;
  is_edit_protected: number;
};

type WalkState = {
  startedAt: number;
  entries: number;
  entryLimit: number;
  budgetMs: number;
  truncated: boolean;
};

type PathSize = {
  bytes: number;
  fileCount: number;
  lastModifiedMs: number | null;
  oldFileBytes: number;
  compressedBytes: number;
};

type ValidatedTarget = {
  target: StorageCleanupTarget;
  path: string;
  bytes: number;
  label: string;
  identity: string;
};

export type StorageInsightsServiceOptions = {
  projectRoot: string;
  adeHome: string;
  db: AdeDb;
  logger: Logger;
  cacheTtlMs?: number;
  scanEntryLimit?: number;
  scanBudgetMs?: number;
  diskPressure?: DiskPressureMonitor | null;
  isPathActive?: (path: string) => boolean;
  /** Salted before send; used only to scope the maintenance analytics dedupe. */
  projectId?: string | null;
  /** Emits the per-run `ade_feature_used` maintenance event at the daemon boundary. */
  captureAnalytics?: StorageDoctorAnalyticsCapture | null;
  /**
   * Root scanned for `ade-*` build/release staging directories. Defaults to
   * `os.tmpdir()`; overridable so tests never touch the real system temp dir.
   */
  stagingTmpDir?: string;
  laneService?: LaneLifecycleBackend | null;
  projectConfigService?: LaneCleanupConfigReader | null;
  releaseLaneRuntimeResources?: ((laneId: string) => void | Promise<void>) | null;
  /**
   * Drops the proof records whose stored file lived at or under a removed path.
   * Injected rather than imported so this service keeps its single dependency
   * on the filesystem; absent in the daemon-backed fallback instance, where the
   * broker lives in the other process and prunes on its own next read.
   */
  purgeProofRecordsUnder?: (removedPath: string) => void;
};

export function isObsoleteRecoveryBackup(
  backupPath: string,
  options: { projectRoot: string; db: AdeDb; now?: number },
): boolean {
  const now = options.now ?? Date.now();
  if (!RECOVERY_BACKUP_PATTERN.test(path.basename(backupPath))) return false;
  let backup: fs.Stats;
  try {
    backup = fs.statSync(backupPath);
  } catch {
    return false;
  }
  if (!backup.isFile() || now - backup.mtimeMs <= STALE_AGE_MS) return false;
  const lastFailure = readLastFailure({ kind: "project", projectRoot: options.projectRoot });
  const failureAt = lastFailure ? Date.parse(lastFailure.at) : Number.NaN;
  if (
    lastFailure?.component === "project_db_open"
    && Number.isFinite(failureAt)
    && now - failureAt >= 0
    && now - failureAt <= STALE_AGE_MS
  ) {
    return false;
  }
  try {
    return runQuickCheck(options.db).healthy === true;
  } catch {
    return false;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isSameOrWithin(parent: string, candidate: string): boolean {
  return path.resolve(parent) === path.resolve(candidate) || isWithin(parent, candidate);
}

function isDirectChild(parent: string, candidate: string): boolean {
  const normalizedParent = path.resolve(parent);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate !== normalizedParent
    && path.dirname(normalizedCandidate) === normalizedParent
    && path.basename(normalizedCandidate).trim().length > 0;
}

function isoOrNull(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function itemId(category: StorageCategoryId, base: string, itemPath: string): string {
  const relative = path.relative(base, itemPath) || path.basename(itemPath);
  return `${category}:${relative.split(path.sep).join("/")}`;
}

function dominantSafety(items: StorageItem[], fallback: StorageSafety): StorageSafety {
  const rank: Record<StorageSafety, number> = {
    safe_to_remove: 0,
    compressible: 1,
    review_first: 2,
    protected: 3,
  };
  return items.reduce((result, item) => rank[item.safety] > rank[result] ? item.safety : result, fallback);
}

async function lstatOrNull(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if (isEnoentError(error)) return null;
    throw error;
  }
}

async function hasSymlinkAncestor(anchorPath: string, targetPath: string): Promise<boolean> {
  const anchor = path.resolve(anchorPath);
  const target = path.resolve(targetPath);
  if (!isSameOrWithin(anchor, target)) return true;
  const relative = path.relative(anchor, target);
  const segments = relative ? relative.split(path.sep) : [];
  let current = anchor;
  const pathsToCheck = [current];
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    pathsToCheck.push(current);
  }
  for (const candidate of pathsToCheck) {
    const stat = await lstatOrNull(candidate);
    if (stat?.isSymbolicLink()) return true;
  }
  return false;
}

async function walkPath(
  rootPath: string,
  state: WalkState | null,
  excludedRoots: readonly string[] = [],
): Promise<PathSize> {
  const result: PathSize = { bytes: 0, fileCount: 0, lastModifiedMs: null, oldFileBytes: 0, compressedBytes: 0 };
  const pending = [path.resolve(rootPath)];
  const oldBefore = Date.now() - COMPRESSIBLE_AGE_MS;

  while (pending.length > 0) {
    if (state && (state.entries >= state.entryLimit || Date.now() - state.startedAt >= state.budgetMs)) {
      state.truncated = true;
      break;
    }
    const batch = pending.splice(0, WALK_CONCURRENCY);
    const inspected = await Promise.all(batch.map(async (currentPath) => {
      if (excludedRoots.some((excluded) => isSameOrWithin(excluded, currentPath))) return null;
      if (state) {
        if (state.entries >= state.entryLimit) {
          state.truncated = true;
          return null;
        }
        state.entries += 1;
      }
      const stat = await lstatOrNull(currentPath);
      if (!stat) return null;
      if (!stat.isDirectory()) return { currentPath, stat, children: [] as string[] };
      let names: string[];
      try {
        names = await fs.promises.readdir(currentPath);
      } catch (error) {
        if (isEnoentError(error)) return null;
        throw error;
      }
      return { currentPath, stat, children: names.map((name) => path.join(currentPath, name)) };
    }));

    for (const entry of inspected) {
      if (!entry) continue;
      result.lastModifiedMs = Math.max(result.lastModifiedMs ?? 0, entry.stat.mtimeMs);
      if (entry.stat.isDirectory()) {
        pending.push(...entry.children);
      } else {
        result.bytes += entry.stat.size;
        result.fileCount += 1;
        if (entry.currentPath.endsWith(".gz")) result.compressedBytes += entry.stat.size;
        else if (entry.stat.mtimeMs < oldBefore) result.oldFileBytes += entry.stat.size;
      }
    }
  }
  return result;
}

async function readdirOrEmpty(dirPath: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dirPath);
  } catch (error) {
    if (isEnoentError(error)) return [];
    throw error;
  }
}

export function createStorageInsightsService(options: StorageInsightsServiceOptions) {
  const projectRoot = path.resolve(options.projectRoot);
  const adeHome = path.resolve(options.adeHome);
  const layout = resolveAdeLayout(projectRoot);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const scanEntryLimit = options.scanEntryLimit ?? DEFAULT_SCAN_ENTRY_LIMIT;
  const scanBudgetMs = options.scanBudgetMs ?? DEFAULT_SCAN_BUDGET_MS;
  const isPathActive = options.isPathActive ?? (() => true);
  let cachedSnapshot: { value: StorageSnapshot; createdAt: number } | null = null;
  const compressionRoots: CompressionRoots = [
    { path: layout.chatTranscriptsDir, kind: "chat_transcript" },
    // PTY transcripts are direct children. Nested process/test logs have
    // independent writers and are deliberately excluded from automatic work.
    { path: layout.transcriptsDir, kind: "terminal_log", recursive: false },
  ];
  const compressor = createHistoryCompressor({
    logger: options.logger,
    diskPressure: options.diskPressure,
    // Without the runtime's in-memory ownership signal, compression is unsafe.
    isPathActive,
  });
  // `.ade/tmp` is a project-relative release-staging root (distinct from the
  // `.ade/cache/tmp` layout dir) written by the /release skill and never cleaned
  // by app code. `stagingTmpRoot` holds the `ade-*` system-temp staging dirs.
  const adeTmpDir = path.join(layout.adeDir, "tmp");
  const stagingTmpRoot = options.stagingTmpDir ? path.resolve(options.stagingTmpDir) : os.tmpdir();
  const iosDerivedDataDir = path.join(layout.cacheDir, "ios-simulator", "DerivedData");
  const journalPath = path.join(layout.cacheDir, MAINTENANCE_JOURNAL_FILENAME);
  let sweepFlight: Promise<CompressionSweepSummary> | null = null;
  let maintenanceFlight: Promise<MaintenanceRunReport> | null = null;
  let lifecycleFlight: Promise<void> | null = null;
  let cleanupQueue: Promise<void> = Promise.resolve();
  let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;
  let dailySweepTimer: ReturnType<typeof setInterval> | null = null;
  let lifecycleTimer: ReturnType<typeof setInterval> | null = null;

  const lifecyclePolicy = () => {
    const cleanup = options.projectConfigService?.get().effective.laneCleanup ?? {};
    return {
      maxActiveLanes: Math.max(0, Math.floor(cleanup.maxActiveLanes ?? 0)),
      cleanupIntervalHours: Math.max(0, Math.floor(cleanup.cleanupIntervalHours ?? 0)),
      autoArchiveAfterHours: Math.max(0, Math.floor(cleanup.autoArchiveAfterHours ?? 0)),
      reclaimArchivedAfterHours: Math.max(0, Math.floor(
        cleanup.reclaimArchivedAfterHours ?? cleanup.autoDeleteArchivedAfterHours ?? 0,
      )),
    };
  };

  const latestLaneActivityMs = (laneId: string, createdAt: string): number => {
    const values = [Date.parse(createdAt)];
    const chat = options.db.get<{ value: string | null }>(
      "select max(updated_at) as value from claude_sessions where lane_id = ?",
      [laneId],
    )?.value;
    const terminal = options.db.get<{ value: string | null }>(
      "select max(coalesce(last_output_at, ended_at, started_at)) as value from terminal_sessions where lane_id = ?",
      [laneId],
    )?.value;
    const operation = options.db.get<{ value: string | null }>(
      "select max(coalesce(ended_at, started_at)) as value from operations where project_id = ? and lane_id = ?",
      [options.projectId ?? "", laneId],
    )?.value;
    for (const value of [chat, terminal, operation]) {
      if (!value) continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) values.push(parsed);
    }
    const validValues = values.filter(Number.isFinite);
    return validValues.length > 0 ? Math.max(...validValues) : Date.now();
  };

  const hasActiveLaneWorktreeLock = (laneId: string): boolean => {
    const now = Date.now();
    const locks = options.db.all<{ expires_at: string }>(
      "select expires_at from lane_worktree_locks where lane_id = ?",
      [laneId],
    );
    return locks.some((lock) => {
      const expiresAt = Date.parse(lock.expires_at);
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
  };

  const runLifecycleScan = (): Promise<void> => {
    if (lifecycleFlight) return lifecycleFlight;
    lifecycleFlight = (async () => {
      const laneService = options.laneService;
      const projectId = options.projectId?.trim();
      if (!laneService || !options.projectConfigService || !projectId) return;
      const policy = lifecyclePolicy();
      if (policy.cleanupIntervalHours <= 0) return;
      const previous = options.db.get<{ last_scan_at: string | null }>(
        "select last_scan_at from local_storage_lifecycle_runs where project_id = ?",
        [projectId],
      );
      const lastScanMs = previous?.last_scan_at ? Date.parse(previous.last_scan_at) : 0;
      const intervalMs = policy.cleanupIntervalHours * 60 * 60_000;
      if (Number.isFinite(lastScanMs) && lastScanMs > 0 && Date.now() - lastScanMs < intervalMs) return;

      const rows = listLaneRows();
      const active = await laneService.list({ includeArchived: false, includeStatus: true });
      const candidates: Array<{ laneId: string; lastActivityMs: number; dueByAge: boolean }> = [];
      for (const lane of active) {
        if (lane.laneType !== "worktree" || lane.isEditProtected || lane.status.dirty) continue;
        if (hasActiveLaneWorktreeLock(lane.id)) continue;
        const row = rows.find((entry) => entry.id === lane.id);
        if (!row) continue;
        const inPrGroup = options.db.get<{ group_id: string }>(
          `select m.group_id from pr_group_members m
             join pr_groups g on g.id = m.group_id
            where m.lane_id = ? and g.project_id = ?
            limit 1`,
          [lane.id, projectId],
        );
        if (inPrGroup) continue;
        const risk = await laneService.getReclaimRisk(lane.id);
        if (risk.dirty || risk.activeChatCount > 0 || risk.activePtyCount > 0 || risk.activeWatcherCount > 0) continue;
        if (risk.blockedReasons.some((reason) => reason.code === "unmerged_work")) continue;
        const lastActivityMs = latestLaneActivityMs(lane.id, row.created_at);
        const dueByAge = policy.autoArchiveAfterHours > 0
          && Date.now() - lastActivityMs >= policy.autoArchiveAfterHours * 60 * 60_000;
        candidates.push({ laneId: lane.id, lastActivityMs, dueByAge });
      }
      candidates.sort((left, right) => left.lastActivityMs - right.lastActivityMs);
      const nonPrimaryActive = active.filter((lane) => lane.laneType !== "primary");
      let stillNeedsArchive = policy.maxActiveLanes > 0
        ? Math.max(0, nonPrimaryActive.length - policy.maxActiveLanes)
        : 0;
      let archivedAutomatically = 0;
      for (const candidate of candidates) {
        if (!candidate.dueByAge && stillNeedsArchive <= 0) continue;
        try {
          if (hasActiveLaneWorktreeLock(candidate.laneId)) continue;
          // Await before the lease release: the lane's processes have to be
          // gone before their ports are handed back.
          await laneService.archive({ laneId: candidate.laneId });
          await options.releaseLaneRuntimeResources?.(candidate.laneId);
          archivedAutomatically += 1;
          if (stillNeedsArchive > 0) stillNeedsArchive -= 1;
        } catch (error) {
          options.logger.warn("storage.lifecycle_auto_archive_skipped", {
            laneId: candidate.laneId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (policy.reclaimArchivedAfterHours > 0) {
        const archived = listLaneRows().filter((row) => row.archived_at);
        for (const row of archived) {
          const archivedMs = Date.parse(row.archived_at ?? "");
          if (!Number.isFinite(archivedMs)) continue;
          if (Date.now() - archivedMs < policy.reclaimArchivedAfterHours * 60 * 60_000) continue;
          if (!isDirectChild(layout.worktreesDir, row.worktree_path)) continue;
          const stat = await lstatOrNull(row.worktree_path);
          if (!stat || stat.isSymbolicLink()) continue;
          const now = new Date().toISOString();
          options.db.run(
            `insert into local_lane_storage_state(
               lane_id, project_id, worktree_path, reclaim_state, last_known_bytes,
               attempts, last_error, reclaimed_at, updated_at
             ) values(?, ?, ?, 'ready_for_review', 0, 0, null, null, ?)
             on conflict(lane_id) do update set
               reclaim_state = case
                 when local_lane_storage_state.reclaim_state = 'reclaimed' then 'reclaimed'
                 else 'ready_for_review'
               end,
               worktree_path = excluded.worktree_path,
               updated_at = excluded.updated_at`,
            [row.id, projectId, row.worktree_path, now],
          );
        }
      }

      const now = new Date().toISOString();
      const nextScanAt = new Date(Date.now() + intervalMs).toISOString();
      options.db.run(
        `insert into local_storage_lifecycle_runs(
           project_id, last_scan_at, next_scan_at, archived_automatically, updated_at
         ) values(?, ?, ?, ?, ?)
         on conflict(project_id) do update set
           last_scan_at = excluded.last_scan_at,
           next_scan_at = excluded.next_scan_at,
           archived_automatically = local_storage_lifecycle_runs.archived_automatically + excluded.archived_automatically,
           updated_at = excluded.updated_at`,
        [projectId, now, nextScanAt, archivedAutomatically, now],
      );
      cachedSnapshot = null;
    })().finally(() => {
      lifecycleFlight = null;
    });
    return lifecycleFlight;
  };

  const overlapsIosDerivedData = (targetPath: string): boolean =>
    isSameOrWithin(targetPath, iosDerivedDataDir) || isSameOrWithin(iosDerivedDataDir, targetPath);

  const iosDerivedDataBlockReason = (lastModifiedMs: number | null): string | null => {
    if (isPathActive(iosDerivedDataDir)) return "An iOS build is currently using this data.";
    if (lastModifiedMs != null && Date.now() - lastModifiedMs <= STALE_AGE_MS) {
      return "This iOS build data was used recently and may still be in use.";
    }
    return null;
  };

  const runCompressionSweep = (opts?: { maxFiles?: number }): Promise<CompressionSweepSummary> => {
    if (sweepFlight) return sweepFlight;
    sweepFlight = compressor.runIdleSweep(compressionRoots, opts).finally(() => {
      sweepFlight = null;
      cachedSnapshot = null;
    });
    return sweepFlight;
  };

  const statSizeOrNull = (targetPath: string): number | null => {
    try {
      return fs.statSync(targetPath).size;
    } catch {
      return null;
    }
  };

  const computeDbBreakdown = (syncBookkeepingAction: DbBreakdownEntry["action"]): DbBreakdownEntry[] => {
    // dbstat is a compile-time-optional virtual table; degrade to no breakdown
    // (empty list) when the SQLite build lacks it rather than failing the scan.
    try {
      const rows = options.db.all<{ name: string; bytes: number }>(
        "select name, sum(pgsize) as bytes from dbstat group by name",
      );
      return mapDbBreakdown(rows, { syncBookkeeping: syncBookkeepingAction });
    } catch (error) {
      options.logger.debug("storage.db_breakdown_unavailable", {
        projectRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const listLaneRows = (): LaneRow[] => options.db.all<LaneRow>(
    "select id, name, worktree_path, archived_at, created_at, lane_type, is_edit_protected from lanes",
  );

  const laneForPath = (targetPath: string, laneId?: string, rows: LaneRow[] = listLaneRows()): LaneRow | null => {
    const normalized = path.resolve(targetPath);
    // Match ONLY by exact resolved worktree_path. A basename fallback would let
    // an unrelated lane (e.g. an archived lane at /tmp/feature) validate a
    // same-named managed worktree (.ade/worktrees/feature) and authorize
    // deleting an active lane's files — a data-loss hole.
    return rows.find((row) => {
      if (laneId && row.id !== laneId) return false;
      return path.resolve(row.worktree_path) === normalized;
    }) ?? null;
  };

  const makeItem = async (args: {
    category: StorageCategoryId;
    base: string;
    path: string;
    label: string;
    safety: StorageSafety;
    state: WalkState;
    detail?: string;
    laneStatus?: StorageItem["laneStatus"];
    excludedRoots?: string[];
  }): Promise<{ item: StorageItem; oldFileBytes: number; compressedBytes: number } | null> => {
    const anchor = isSameOrWithin(projectRoot, args.path)
      ? projectRoot
      : isSameOrWithin(adeHome, args.path)
        ? adeHome
        : args.base;
    if (await hasSymlinkAncestor(anchor, args.path)) return null;
    const stat = await lstatOrNull(args.path);
    if (!stat) return null;
    const size = await walkPath(args.path, args.state, args.excludedRoots);
    return {
      item: {
        id: itemId(args.category, args.base, args.path),
        label: args.label,
        path: args.path,
        bytes: size.bytes,
        fileCount: size.fileCount,
        lastModifiedAt: isoOrNull(size.lastModifiedMs ?? stat.mtimeMs),
        safety: args.safety,
        ...(args.detail ? { detail: args.detail } : {}),
        ...(args.laneStatus ? { laneStatus: args.laneStatus } : {}),
      },
      oldFileBytes: size.oldFileBytes,
      compressedBytes: size.compressedBytes,
    };
  };

  const buildCategory = (
    id: StorageCategoryId,
    allItems: StorageItem[],
    fallbackSafety: StorageSafety,
    state: WalkState,
    compressibleBytes?: number,
    compressedBytes?: number,
  ): StorageCategorySnapshot => {
    const sorted = [...allItems].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
    if (sorted.length > MAX_CATEGORY_ITEMS) state.truncated = true;
    return {
      id,
      bytes: allItems.reduce((sum, item) => sum + item.bytes, 0),
      fileCount: allItems.reduce((sum, item) => sum + item.fileCount, 0),
      safety: dominantSafety(allItems, fallbackSafety),
      items: sorted.slice(0, MAX_CATEGORY_ITEMS),
      ...(compressibleBytes == null ? {} : { compressibleBytes }),
      ...(compressedBytes == null ? {} : { compressedBytes }),
    };
  };

  const getSnapshot = async (args: { forceRefresh?: boolean } = {}): Promise<StorageSnapshot> => {
    if (!args.forceRefresh && cachedSnapshot && Date.now() - cachedSnapshot.createdAt < cacheTtlMs) {
      return cachedSnapshot.value;
    }
    const startedAt = Date.now();
    const state: WalkState = { startedAt, entries: 0, entryLimit: scanEntryLimit, budgetMs: scanBudgetMs, truncated: false };
    const categoryItems = new Map<StorageCategoryId, StorageItem[]>();
    const add = (category: StorageCategoryId, value: StorageItem | null | undefined) => {
      if (!value) return;
      const items = categoryItems.get(category) ?? [];
      items.push(value);
      categoryItems.set(category, items);
    };

    let compressibleBytes = 0;
    let compressedBytes = 0;
    for (const [chatPath, label] of [
      [layout.transcriptsDir, "Chat and terminal history"],
      [path.join(layout.cacheDir, "terminal-snapshots"), "Terminal snapshots"],
    ] as const) {
      const entry = await makeItem({ category: "chats_history", base: layout.adeDir, path: chatPath, label, safety: "compressible", state });
      if (entry) {
        add("chats_history", entry.item);
        compressibleBytes += entry.oldFileBytes;
        compressedBytes += entry.compressedBytes;
      }
    }

    const lanes = listLaneRows();
    const laneStorageStates = new Map(options.db.all<{
      lane_id: string;
      reclaim_state: StorageItem["reclaimState"];
      last_known_bytes: number;
      last_error: string | null;
    }>(
      "select lane_id, reclaim_state, last_known_bytes, last_error from local_lane_storage_state where project_id = ?",
      [options.projectId ?? ""],
    ).map((entry) => [entry.lane_id, entry] as const));
    const worktreeNames = await readdirOrEmpty(layout.worktreesDir);
    for (const name of worktreeNames) {
      const worktreePath = path.join(layout.worktreesDir, name);
      const stat = await lstatOrNull(worktreePath);
      if (!stat) continue;
      const row = laneForPath(worktreePath, undefined, lanes);
      const laneStatus: StorageItem["laneStatus"] = !row ? "orphaned" : row.archived_at ? "archived" : "active";
      const entry = await makeItem({
        category: "lanes_worktrees",
        base: layout.worktreesDir,
        path: worktreePath,
        label: row?.name ?? name,
        safety: laneStatus === "active" ? "protected" : "review_first",
        state,
        laneStatus,
        ...(laneStatus === "archived"
          ? { detail: "Archived lane — its files are kept until you remove them" }
          : laneStatus === "orphaned"
            ? { detail: "Left over from a deleted lane" }
            : {}),
      });
      if (entry) {
        const storageState = row ? laneStorageStates.get(row.id) : null;
        entry.item.ownership = "ADE-managed";
        entry.item.reclaimableBytes = laneStatus === "active" ? 0 : entry.item.bytes;
        entry.item.ageHours = entry.item.lastModifiedAt
          ? Math.max(0, (Date.now() - Date.parse(entry.item.lastModifiedAt)) / (60 * 60_000))
          : null;
        if (row) entry.item.laneId = row.id;
        if (storageState?.reclaim_state) entry.item.reclaimState = storageState.reclaim_state;
        if (storageState?.last_error) entry.item.blockedReasons = [`Last cleanup failed: ${storageState.last_error}`];
        add("lanes_worktrees", entry.item);
      }
    }
    for (const row of lanes.filter((lane) => lane.archived_at && !fs.existsSync(lane.worktree_path))) {
      const storageState = laneStorageStates.get(row.id);
      add("lanes_worktrees", {
        id: `lanes_worktrees:reclaimed:${row.id}`,
        label: row.name,
        path: row.worktree_path,
        bytes: 0,
        fileCount: 0,
        lastModifiedAt: row.archived_at,
        safety: "protected",
        detail: "Lane kept. Its local folder has been reclaimed and will be recreated when restored.",
        laneStatus: "archived",
        ownership: "ADE-managed",
        blockedReasons: storageState?.last_error ? [`Last cleanup failed: ${storageState.last_error}`] : [],
        reclaimableBytes: storageState?.reclaim_state === "failed"
          ? Math.max(0, storageState.last_known_bytes)
          : 0,
        ageHours: Math.max(0, (Date.now() - Date.parse(row.archived_at!)) / (60 * 60_000)),
        laneId: row.id,
        reclaimState: storageState?.reclaim_state ?? "reclaimed",
      });
    }

    const tempNames = await readdirOrEmpty(stagingTmpRoot);
    for (const name of tempNames.filter((value) => /^ade-/.test(value))) {
      const tempPath = path.join(stagingTmpRoot, name);
      if (path.resolve(tempPath) === projectRoot || path.resolve(tempPath) === adeHome) continue;
      const stat = await lstatOrNull(tempPath);
      // Skip symlinked staging dirs: the reaper's collectors refuse them, so
      // showing one here would be an item cleanup could never act on.
      if (!stat || stat.isSymbolicLink()) continue;
      const stale = Date.now() - stat.mtimeMs > STALE_AGE_MS;
      const entry = await makeItem({
        category: "build_release",
        base: stagingTmpRoot,
        path: tempPath,
        label: "Release and build staging",
        safety: stale ? "safe_to_remove" : "review_first",
        state,
        detail: stale ? "Old staging files are no longer in use" : "A current operation may still be using these files",
      });
      add("build_release", entry?.item);
    }
    // `.ade/tmp` direct children: /release-skill staging that nothing else reaps.
    const adeTmpNames = await readdirOrEmpty(adeTmpDir);
    for (const name of adeTmpNames) {
      const adeTmpPath = path.join(adeTmpDir, name);
      const stat = await lstatOrNull(adeTmpPath);
      if (!stat || stat.isSymbolicLink()) continue;
      const stale = Date.now() - stat.mtimeMs > STALE_AGE_MS;
      const entry = await makeItem({
        category: "build_release",
        base: adeTmpDir,
        path: adeTmpPath,
        label: "Release staging",
        safety: stale ? "safe_to_remove" : "review_first",
        state,
        detail: stale ? "Old release staging is no longer in use" : "A current release may still be using these files",
      });
      add("build_release", entry?.item);
    }
    const derivedData = iosDerivedDataDir;
    const derivedDataEntry = await makeItem({
      category: "build_release",
      base: layout.adeDir,
      path: derivedData,
      label: "iOS build data",
      safety: "review_first",
      state,
    });
    if (derivedDataEntry) {
      const lastModifiedMs = derivedDataEntry.item.lastModifiedAt
        ? Date.parse(derivedDataEntry.item.lastModifiedAt)
        : null;
      const blockedReason = iosDerivedDataBlockReason(lastModifiedMs);
      derivedDataEntry.item.safety = blockedReason ? "review_first" : "safe_to_remove";
      derivedDataEntry.item.detail = blockedReason ?? "Recreated the next time you build";
      add("build_release", derivedDataEntry.item);
    }

    const cacheNames = await readdirOrEmpty(layout.cacheDir);
    for (const name of cacheNames) {
      if (name === "terminal-snapshots") continue;
      const cachePath = path.join(layout.cacheDir, name);
      const protectedItem = name === "chat-sessions";
      const entry = await makeItem({
        category: "caches",
        base: layout.cacheDir,
        path: cachePath,
        label: protectedItem ? "Chat session records" : name,
        safety: protectedItem ? "protected" : "safe_to_remove",
        state,
        ...(protectedItem ? { detail: "Required to keep existing chats available" } : { detail: "Recreated when needed" }),
        ...(name === "ios-simulator" ? { excludedRoots: [derivedData] } : {}),
      });
      if (entry && (entry.item.bytes > 0 || name !== "ios-simulator")) add("caches", entry.item);
    }

    const updatesDir = path.join(adeHome, "runtime", "updates");
    const updateNames = await readdirOrEmpty(updatesDir);
    for (const name of updateNames) {
      const updatePath = path.join(updatesDir, name);
      const stat = await lstatOrNull(updatePath);
      if (!stat) continue;
      const stale = Date.now() - stat.mtimeMs > STALE_AGE_MS;
      add("caches", (await makeItem({
        category: "caches",
        base: updatesDir,
        path: updatePath,
        label: "App update staging",
        safety: stale ? "safe_to_remove" : "review_first",
        state,
        detail: stale ? "Old update files are no longer needed" : "An update may still be using these files",
      }))?.item);
    }

    const proofPath = path.join(layout.artifactsDir, "computer-use");
    add("proof_attachments", (await makeItem({
      category: "proof_attachments",
      base: layout.adeDir,
      path: proofPath,
      label: "Proof and recordings",
      safety: "review_first",
      state,
    }))?.item);

    const adeNames = await readdirOrEmpty(layout.adeDir);
    for (const name of adeNames.filter((value) => RECOVERY_BACKUP_PATTERN.test(value))) {
      const backupPath = path.join(layout.adeDir, name);
      add("recovery_backups", (await makeItem({
        category: "recovery_backups",
        base: layout.adeDir,
        path: backupPath,
        label: "Recovery backup",
        safety: isObsoleteRecoveryBackup(backupPath, { projectRoot, db: options.db })
          ? "safe_to_remove"
          : "review_first",
        state,
      }))?.item);
    }

    for (const databasePath of [layout.dbPath, `${layout.dbPath}-wal`, `${layout.dbPath}-shm`]) {
      add("database", (await makeItem({
        category: "database",
        base: layout.adeDir,
        path: databasePath,
        label: databasePath === layout.dbPath ? "Project database" : "Project database support file",
        safety: "protected",
        state,
      }))?.item);
    }

    const categories = [
      buildCategory("chats_history", categoryItems.get("chats_history") ?? [], "compressible", state, compressibleBytes, compressedBytes),
      buildCategory("lanes_worktrees", categoryItems.get("lanes_worktrees") ?? [], "review_first", state),
      buildCategory("build_release", categoryItems.get("build_release") ?? [], "safe_to_remove", state),
      buildCategory("caches", categoryItems.get("caches") ?? [], "safe_to_remove", state),
      buildCategory("proof_attachments", categoryItems.get("proof_attachments") ?? [], "review_first", state),
      buildCategory("recovery_backups", categoryItems.get("recovery_backups") ?? [], "review_first", state),
      buildCategory("database", categoryItems.get("database") ?? [], "protected", state),
    ];
    for (const category of categories) {
      for (const item of category.items) {
        item.ownership ??= item.path.startsWith(stagingTmpRoot)
          ? "System temporary"
          : item.path.startsWith(layout.adeDir)
            ? "ADE-managed"
            : "Project-owned";
        item.reclaimableBytes ??= item.safety === "protected" ? 0 : item.bytes;
        item.ageHours ??= item.lastModifiedAt
          ? Math.max(0, (Date.now() - Date.parse(item.lastModifiedAt)) / (60 * 60_000))
          : null;
        if (!item.blockedReasons && item.safety !== "safe_to_remove" && item.detail) {
          item.blockedReasons = [item.detail];
        }
      }
    }
    const journal = readMaintenanceJournal(journalPath);
    const dbBreakdown = computeDbBreakdown(deriveSyncBookkeepingAction(journal));
    // Estimate only work the same backend validator will authorize. Raw
    // compressible bytes are not predicted savings, and dbstat table totals do
    // not identify the expired rows (or the bytes a later vacuum can return),
    // so neither is defensible enough for the primary cleanup promise.
    const candidateTargets = new Map<string, StorageCleanupTarget>();
    for (const category of categories) {
      if (category.id !== "build_release" && category.id !== "caches") continue;
      for (const item of category.items) {
        if (item.safety !== "safe_to_remove") continue;
        const itemPath = path.resolve(item.path);
        if (
          (isDirectChild(stagingTmpRoot, itemPath) && /^ade-/.test(path.basename(itemPath)))
          || isDirectChild(adeTmpDir, itemPath)
        ) {
          candidateTargets.set(itemPath, { kind: "stale_tmp_staging", path: itemPath });
        } else if (isWithin(layout.cacheDir, itemPath)) {
          candidateTargets.set(itemPath, { kind: "rebuildable_cache", path: itemPath });
        }
      }
    }
    // Prefer an accepted ancestor over descendants so nested cache entries can
    // never inflate the estimate by counting the same bytes twice.
    const acceptedPaths: string[] = [];
    let safeReclaimableBytes = 0;
    for (const target of [...candidateTargets.values()].sort((left, right) => left.path.length - right.path.length)) {
      if (acceptedPaths.some((acceptedPath) => isSameOrWithin(acceptedPath, target.path))) continue;
      const checked = await validateTarget(target);
      if (!checked.valid) continue;
      acceptedPaths.push(checked.valid.path);
      safeReclaimableBytes += checked.valid.bytes;
    }
    const extras: StorageSnapshotExtras = {
      dbBreakdown,
      maintenance: { lastRun: journal[0] ?? null, journal },
      safeReclaimableBytes,
      policyChips: deriveCategoryPolicyChips(),
    };
    const snapshot: StorageSnapshot = {
      generatedAt: new Date().toISOString(),
      projectRoot,
      volume: readVolumeSpace(projectRoot) ?? { freeBytes: 0, totalBytes: 0 },
      totalAdeBytes: categories.reduce((sum, category) => sum + category.bytes, 0),
      categories,
      scanDurationMs: Date.now() - startedAt,
      truncated: state.truncated,
      extras,
      lifecycle: (() => {
        const policy = lifecyclePolicy();
        const run = options.projectId
          ? options.db.get<{
              last_scan_at: string | null;
              next_scan_at: string | null;
              archived_automatically: number;
            }>(
              "select last_scan_at, next_scan_at, archived_automatically from local_storage_lifecycle_runs where project_id = ?",
              [options.projectId],
            )
          : null;
        const reviewReadyCount = [...laneStorageStates.values()]
          .filter((entry) => entry.reclaim_state === "ready_for_review" || entry.reclaim_state === "failed")
          .length;
        return {
          lastScanAt: run?.last_scan_at ?? null,
          nextScanAt: run?.next_scan_at ?? null,
          scanInProgress: lifecycleFlight != null,
          policy,
          archivedAutomatically: run?.archived_automatically ?? 0,
          reviewReadyCount,
        };
      })(),
    };
    if (state.truncated) {
      options.logger.warn("storage.scan_truncated", { projectRoot, entries: state.entries, entryLimit: state.entryLimit, budgetMs: state.budgetMs });
    }
    cachedSnapshot = { value: snapshot, createdAt: Date.now() };
    return snapshot;
  };

  const validateTarget = async (target: StorageCleanupTarget): Promise<{ valid: ValidatedTarget | null; reason?: string }> => {
    if (!target || typeof target.path !== "string" || !path.isAbsolute(target.path)) {
      return { valid: null, reason: "The cleanup path must be an absolute path." };
    }
    const targetPath = path.resolve(target.path);
    const stat = await lstatOrNull(targetPath);
    if (!stat) return { valid: null, reason: "This item no longer exists." };
    if (stat.isSymbolicLink()) return { valid: null, reason: "Links cannot be removed by storage cleanup." };

    let label = path.basename(targetPath);
    if (target.kind === "orphaned_worktree" || target.kind === "archived_lane_worktree") {
      if (await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      if (!isDirectChild(layout.worktreesDir, targetPath)) {
        return { valid: null, reason: "This path is not a managed lane worktree." };
      }
      const lane = laneForPath(targetPath, target.kind === "archived_lane_worktree" ? target.laneId : undefined);
      if (target.kind === "orphaned_worktree" && lane) {
        return { valid: null, reason: lane.archived_at ? "This lane is archived; select it as an archived lane." : "Active lane files are protected." };
      }
      if (target.kind === "archived_lane_worktree" && (!lane || !lane.archived_at)) {
        return { valid: null, reason: lane ? "Active lane files are protected." : "This lane is not archived." };
      }
      if (target.kind === "archived_lane_worktree") {
        return {
          valid: null,
          reason: "Use Archive & Reclaim so ADE can check running, dirty, and unmerged work before removing this lane folder.",
        };
      }
      label = lane?.name ?? path.basename(targetPath);
    } else if (target.kind === "stale_tmp_staging") {
      // Two staging roots share this kind: `ade-*` dirs in the system temp root,
      // and any direct child of the project-relative `.ade/tmp` release-staging
      // dir. Direct-child containment is the safety boundary for both.
      const inSystemStaging = isDirectChild(stagingTmpRoot, targetPath) && /^ade-/.test(path.basename(targetPath));
      const inProjectStaging = isDirectChild(adeTmpDir, targetPath);
      if (!inSystemStaging && !inProjectStaging) {
        return { valid: null, reason: "This path is not ADE staging data." };
      }
      if (inProjectStaging && await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      if (targetPath === projectRoot || targetPath === adeHome) {
        return { valid: null, reason: "Project data is protected." };
      }
      if (Date.now() - stat.mtimeMs <= STALE_AGE_MS) {
        return { valid: null, reason: "This staging data may still be in use." };
      }
      label = "Old release staging";
    } else if (target.kind === "rebuildable_cache") {
      if (await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      if (!isWithin(layout.cacheDir, targetPath)) {
        return { valid: null, reason: "This path is not a rebuildable project cache." };
      }
      if (isSameOrWithin(layout.chatSessionsDir, targetPath)) {
        return { valid: null, reason: "Chat session records are protected." };
      }
      if (isSameOrWithin(path.join(layout.cacheDir, "terminal-snapshots"), targetPath)) {
        return { valid: null, reason: "Terminal history is protected from automatic cleanup." };
      }
      label = "Rebuildable cache";
    } else if (target.kind === "recovery_backup") {
      if (await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      if (path.dirname(targetPath) !== layout.adeDir || !RECOVERY_BACKUP_PATTERN.test(path.basename(targetPath))) {
        return { valid: null, reason: "This path is not a project recovery backup." };
      }
      if (!stat.isFile()) return { valid: null, reason: "Recovery backups must be files." };
      label = "Recovery backup";
    } else if (target.kind === "proof_attachments") {
      if (await hasSymlinkAncestor(projectRoot, targetPath)) {
        return { valid: null, reason: "Links cannot be used in a cleanup path." };
      }
      const attachmentsRoot = path.join(layout.adeDir, "attachments");
      if (isSameOrWithin(attachmentsRoot, targetPath)) {
        // This store backs prompt stashes and renderer-owned composer drafts.
        // Main cannot enumerate every active draft, so recursive or per-file
        // cleanup here could delete live user input.
        return {
          valid: null,
          reason: "Composer attachments are live chat data and cannot be removed from Storage.",
        };
      }
      // Same jail the broker and the `ade-artifact://` handler enforce.
      const proofRoot = path.join(layout.artifactsDir, "computer-use");
      if (!isSameOrWithin(proofRoot, targetPath)) {
        return { valid: null, reason: "This path is not proof or attachment storage." };
      }
      label = "Proof and recordings";
    } else {
      return { valid: null, reason: "This cleanup target is not supported." };
    }

    const size = await walkPath(targetPath, null);
    if (
      target.kind === "rebuildable_cache"
      && overlapsIosDerivedData(targetPath)
      && await lstatOrNull(iosDerivedDataDir)
    ) {
      const derivedDataSize = await walkPath(iosDerivedDataDir, null);
      const blockedReason = iosDerivedDataBlockReason(derivedDataSize.lastModifiedMs);
      if (blockedReason) return { valid: null, reason: blockedReason };
    }
    const identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, size.bytes, size.lastModifiedMs ?? 0].join(":");
    return { valid: { target, path: targetPath, bytes: size.bytes, label, identity } };
  };

  const cleanupPreview = async (targets: StorageCleanupTarget[]): Promise<StorageCleanupPreview> => {
    const items: StorageCleanupPreview["items"] = [];
    const blocked: StorageCleanupPreview["blocked"] = [];
    const seen = new Set<string>();
    for (const target of Array.isArray(targets) ? targets : []) {
      const targetPath = typeof target?.path === "string" ? target.path : "";
      const normalized = path.isAbsolute(targetPath) ? path.resolve(targetPath) : targetPath;
      if (seen.has(normalized)) {
        blocked.push({ path: targetPath, reason: "This cleanup item was selected more than once." });
        continue;
      }
      seen.add(normalized);
      const checked = await validateTarget(target);
      if (!checked.valid) {
        blocked.push({ path: targetPath, reason: checked.reason ?? "This item cannot be removed." });
        continue;
      }
      items.push({
        path: checked.valid.path,
        bytes: checked.valid.bytes,
        label: checked.valid.label,
        identity: checked.valid.identity,
      });
    }
    return { items, totalBytes: items.reduce((sum, item) => sum + item.bytes, 0), blocked };
  };

  const removeWorktree = async (targetPath: string): Promise<void> => {
    const removeResult = await runGit(["worktree", "remove", "--force", targetPath], { cwd: projectRoot, timeoutMs: 30_000 });
    if (removeResult.exitCode !== 0) {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
    }
    await runGit(["worktree", "prune"], { cwd: projectRoot, timeoutMs: 30_000 }).catch(() => null);
  };

  const performCleanup = async (
    targets: StorageCleanupTarget[],
    opts: { preview: StorageCleanupPreview },
  ): Promise<StorageCleanupResult> => {
    const removed: StorageCleanupResult["removed"] = [];
    const failed: StorageCleanupResult["failed"] = [];
    const previewByPath = new Map((opts?.preview?.items ?? []).map((item) => [path.resolve(item.path), item]));
    const seen = new Set<string>();

    for (const target of Array.isArray(targets) ? targets : []) {
      const rawPath = typeof target?.path === "string" ? target.path : "";
      const normalized = path.isAbsolute(rawPath) ? path.resolve(rawPath) : rawPath;
      if (seen.has(normalized)) {
        failed.push({ path: rawPath, reason: "This cleanup item was selected more than once." });
        continue;
      }
      seen.add(normalized);
      const previewItem = path.isAbsolute(rawPath) ? previewByPath.get(path.resolve(rawPath)) : undefined;
      if (!previewItem) {
        failed.push({ path: rawPath, reason: "This item was not included in the confirmed preview." });
        continue;
      }
      const checked = await validateTarget(target);
      if (!checked.valid) {
        failed.push({ path: rawPath, reason: checked.reason ?? "This item cannot be removed." });
        continue;
      }
      if (checked.valid.bytes !== previewItem.bytes) {
        failed.push({ path: rawPath, reason: "This item changed after the preview. Preview it again before removing it." });
        continue;
      }
      if (!previewItem.identity || previewItem.identity !== checked.valid.identity) {
        failed.push({ path: rawPath, reason: "This item changed after the preview. Preview it again before removing it." });
        continue;
      }
      if (
        target.kind === "rebuildable_cache"
        && overlapsIosDerivedData(checked.valid.path)
        && await lstatOrNull(iosDerivedDataDir)
      ) {
        const blockedReason = iosDerivedDataBlockReason(
          (await walkPath(iosDerivedDataDir, null)).lastModifiedMs,
        );
        if (blockedReason) {
          failed.push({ path: rawPath, reason: blockedReason });
          continue;
        }
      }
      try {
        if (target.kind === "orphaned_worktree" || target.kind === "archived_lane_worktree") {
          await removeWorktree(checked.valid.path);
        } else {
          await fs.promises.rm(checked.valid.path, { recursive: true, force: false });
        }
        if (target.kind === "proof_attachments") {
          // Rows must not outlive the bytes: a proof record whose file is gone
          // renders as a permanently broken tile in the drawer.
          try {
            options.purgeProofRecordsUnder?.(checked.valid.path);
          } catch (error) {
            options.logger.warn("storage.cleanup_proof_records_failed", {
              path: checked.valid.path,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        removed.push({ path: checked.valid.path, bytes: checked.valid.bytes });
      } catch (error) {
        failed.push({ path: rawPath, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const result: StorageCleanupResult = {
      removed,
      failed,
      freedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    };
    cachedSnapshot = null;
    options.logger.info("storage.cleanup_completed", {
      projectRoot,
      requestedCount: Array.isArray(targets) ? targets.length : 0,
      removedCount: removed.length,
      failedCount: failed.length,
      freedBytes: result.freedBytes,
    });
    return result;
  };

  const cleanup = (
    targets: StorageCleanupTarget[],
    opts: { preview: StorageCleanupPreview },
  ): Promise<StorageCleanupResult> => {
    const run = cleanupQueue.then(() => performCleanup(targets, opts));
    cleanupQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const compressNow = async (): Promise<StorageCompressionResult> => {
    const result = await runCompressionSweep();
    return { filesCompressed: result.filesCompressed, savedBytes: result.savedBytes };
  };

  const collectSystemStaging = async (): Promise<StorageCleanupTarget[]> => {
    const names = await readdirOrEmpty(stagingTmpRoot);
    const targets: StorageCleanupTarget[] = [];
    for (const name of names.filter((value) => /^ade-/.test(value))) {
      const tempPath = path.join(stagingTmpRoot, name);
      if (path.resolve(tempPath) === projectRoot || path.resolve(tempPath) === adeHome) continue;
      const stat = await lstatOrNull(tempPath);
      if (!stat || stat.isSymbolicLink()) continue;
      if (Date.now() - stat.mtimeMs <= STALE_AGE_MS) continue;
      targets.push({ kind: "stale_tmp_staging", path: tempPath });
    }
    return targets;
  };

  const collectProjectStaging = async (): Promise<StorageCleanupTarget[]> => {
    const names = await readdirOrEmpty(adeTmpDir);
    const targets: StorageCleanupTarget[] = [];
    for (const name of names) {
      const tempPath = path.join(adeTmpDir, name);
      const stat = await lstatOrNull(tempPath);
      if (!stat || stat.isSymbolicLink()) continue;
      if (Date.now() - stat.mtimeMs <= STALE_AGE_MS) continue;
      targets.push({ kind: "stale_tmp_staging", path: tempPath });
    }
    return targets;
  };

  const collectObsoleteBackups = async (): Promise<StorageCleanupTarget[]> => {
    const names = await readdirOrEmpty(layout.adeDir);
    // Stat every recovery backup so we can always spare the newest one — the
    // ledger's keepLatest: 1 guarantee. Only strictly-older backups are reap
    // candidates, and only when they classify obsolete.
    const backups: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of names.filter((value) => RECOVERY_BACKUP_PATTERN.test(value))) {
      const backupPath = path.join(layout.adeDir, name);
      const stat = await lstatOrNull(backupPath);
      if (!stat || !stat.isFile()) continue;
      backups.push({ path: backupPath, mtimeMs: stat.mtimeMs });
    }
    if (backups.length <= 1) return [];
    // Newest first; backups[0] is kept no matter what.
    backups.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const targets: StorageCleanupTarget[] = [];
    for (const backup of backups.slice(1)) {
      if (isObsoleteRecoveryBackup(backup.path, { projectRoot, db: options.db })) {
        targets.push({ kind: "recovery_backup", path: backup.path });
      }
    }
    return targets;
  };

  const collectIosDerivedData = async (): Promise<StorageCleanupTarget[]> => {
    const stat = await lstatOrNull(iosDerivedDataDir);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return [];
    return [{ kind: "rebuildable_cache", path: iosDerivedDataDir }];
  };

  // Every step is independently try/caught so one failure never aborts the run.
  const runStep = async (
    actions: MaintenanceAction[],
    ledgerId: string,
    kind: MaintenanceActionKind,
    fn: () => Promise<{ itemsAffected: number; bytesReclaimed: number; skippedReason?: string | null }>,
  ): Promise<void> => {
    const start = Date.now();
    try {
      const result = await fn();
      actions.push({
        ledgerId,
        kind,
        itemsAffected: result.itemsAffected,
        bytesReclaimed: result.bytesReclaimed,
        durationMs: Date.now() - start,
        skippedReason: result.skippedReason ?? null,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      actions.push({
        ledgerId,
        kind,
        itemsAffected: 0,
        bytesReclaimed: 0,
        durationMs: Date.now() - start,
        skippedReason: null,
        error: message,
      });
      options.logger.warn("storage.maintenance_step_failed", { projectRoot, ledgerId, kind, error: message });
    }
  };

  const runMaintenanceSweep = (trigger: MaintenanceTrigger): Promise<MaintenanceRunReport> => {
    if (maintenanceFlight) return maintenanceFlight;
    const start = async (): Promise<MaintenanceRunReport> => {
      const startedAt = new Date().toISOString();
      const actions: MaintenanceAction[] = [];

      // a. Compress inactive chat/terminal history (existing safe mechanics).
      await runStep(actions, "fs.transcripts", "compress", async () => {
        const summary = await runCompressionSweep();
        return { itemsAffected: summary.filesCompressed, bytesReclaimed: summary.savedBytes };
      });

      // Filesystem cleanup is review-only. The doctor may identify candidates,
      // but it never removes a directory without a fresh user preview and
      // confirmation in Settings > Storage.
      const recordReviewCandidates = async (targets: StorageCleanupTarget[]) => ({
        itemsAffected: targets.length,
        bytesReclaimed: 0,
        skippedReason: targets.length > 0 ? "review_required" : "nothing_due",
      });
      await runStep(actions, "fs.tmp_staging", "delete", async () => recordReviewCandidates(await collectSystemStaging()));
      await runStep(actions, "fs.tmp", "delete", async () => recordReviewCandidates(await collectProjectStaging()));
      await runStep(actions, "fs.recovery_backups", "delete", async () => recordReviewCandidates(await collectObsoleteBackups()));
      await runStep(actions, "fs.ios_derived_data", "delete", async () => recordReviewCandidates(await collectIosDerivedData()));

      // d. DB retention hooks. `maintenance` is attached by WS-A's kvDb; until it
      // lands the hooks are undefined and each records an "unsupported" skip.
      const maintenance = options.db.maintenance;
      const runDbStep = (
        ledgerId: string,
        kind: MaintenanceActionKind,
        fn: (() => { itemsAffected: number; bytesReclaimed: number; skippedReason?: string | null }) | undefined,
      ): Promise<void> =>
        runStep(actions, ledgerId, kind, async () => {
          if (!fn) return { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "unsupported" };
          const result = fn();
          return {
            itemsAffected: result.itemsAffected,
            bytesReclaimed: result.bytesReclaimed,
            skippedReason: result.skippedReason ?? null,
          };
        });
      await runDbStep("db.automation_ingress_events", "prune", maintenance?.pruneIngressEvents.bind(maintenance));
      await runDbStep("db.review_run_artifacts", "prune", maintenance?.pruneReviewArtifacts.bind(maintenance));
      await runDbStep("db.pull_request_snapshots", "prune", maintenance?.prunePrSnapshots.bind(maintenance));
      await runDbStep("db.operations_crsql", "compact", maintenance?.compactCrsqlTombstones.bind(maintenance));
      await runDbStep(
        "db.core",
        "vacuum",
        maintenance ? () => maintenance.vacuumIfFragmented(VACUUM_FREELIST_THRESHOLD) : undefined,
      );

      const finishedAt = new Date().toISOString();
      const reclaimedBytes = actions.reduce((sum, action) => sum + Math.max(0, action.bytesReclaimed), 0);
      const report: MaintenanceRunReport = {
        startedAt,
        finishedAt,
        trigger,
        actions,
        reclaimedBytes,
        dbSizeBytes: statSizeOrNull(layout.dbPath),
      };
      appendMaintenanceJournal(journalPath, report, { logger: options.logger, projectRoot });
      cachedSnapshot = null;

      const failedCount = actions.filter((action) => action.error).length;
      const outcome = failedCount === 0 ? "completed" : failedCount >= actions.length ? "failed" : "partial";
      const filesCompressed = actions.find((action) => action.ledgerId === "fs.transcripts")?.itemsAffected ?? 0;
      options.logger.info("storage.maintenance_completed", {
        projectRoot,
        trigger,
        outcome,
        reclaimedBytes,
        filesCompressed,
        failedSteps: failedCount,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      });
      try {
        options.captureAnalytics?.({
          event: "ade_feature_used",
          surface: "desktop",
          properties: {
            feature: "storage_doctor",
            action: "maintenance_run",
            outcome,
            bytes_freed: reclaimedBytes,
            files_compressed: filesCompressed,
          },
          projectId: options.projectId ?? null,
          // Local-only dedupe fingerprint (hashed before send): collapses repeat
          // runs within 20 h into one PostHog event.
          dedupeKey: `storage_doctor_run:${options.projectId ?? projectRoot}`,
          minimumIntervalMs: MAINTENANCE_ANALYTICS_MIN_INTERVAL_MS,
        });
      } catch (error) {
        options.logger.debug("storage.maintenance_analytics_failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return report;
    };
    maintenanceFlight = start().finally(() => {
      maintenanceFlight = null;
    });
    return maintenanceFlight;
  };

  const runMaintenanceNow = async (): Promise<MaintenanceRunReport> => {
    try {
      await runLifecycleScan();
    } catch (error) {
      options.logger.warn("storage.lifecycle_scan_failed", {
        projectRoot,
        trigger: "manual",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return runMaintenanceSweep("manual");
  };

  // The daemon-backed fallback instance (isPathActive without diskPressure) must
  // never schedule automatic maintenance; only the real daemon instance, which
  // supplies both signals, arms the doctor's post-boot + daily timers.
  if (options.isPathActive && options.diskPressure) {
    if (options.laneService && options.projectConfigService && options.projectId) {
      void runLifecycleScan().catch((error) => {
        options.logger.warn("storage.lifecycle_scan_failed", {
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      lifecycleTimer = setInterval(() => {
        void runLifecycleScan().catch((error) => {
          options.logger.warn("storage.lifecycle_scan_failed", {
            projectRoot,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 60_000);
      lifecycleTimer.unref?.();
    }
    firstSweepTimer = setTimeout(() => {
      firstSweepTimer = null;
      void runMaintenanceSweep("post_boot").catch((error) => {
        options.logger.warn("storage.maintenance_failed", {
          projectRoot,
          trigger: "post_boot",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      dailySweepTimer = setInterval(() => {
        void runMaintenanceSweep("daily").catch((error) => {
          options.logger.warn("storage.maintenance_failed", {
            projectRoot,
            trigger: "daily",
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, HISTORY_SWEEP_INTERVAL_MS);
      dailySweepTimer.unref?.();
    }, HISTORY_SWEEP_START_DELAY_MS);
    firstSweepTimer.unref?.();
  }

  const dispose = (): void => {
    if (firstSweepTimer) clearTimeout(firstSweepTimer);
    if (dailySweepTimer) clearInterval(dailySweepTimer);
    if (lifecycleTimer) clearInterval(lifecycleTimer);
    firstSweepTimer = null;
    dailySweepTimer = null;
    lifecycleTimer = null;
  };

  return {
    getSnapshot,
    cleanupPreview,
    cleanup,
    compressNow,
    runMaintenanceNow,
    runLifecycleScanNow: runLifecycleScan,
    dispose,
  };
}
