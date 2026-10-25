export type DiskPressureState = "normal" | "warning" | "critical" | "exhausted";

export type DiskPressureSnapshot = {
  state: DiskPressureState;
  freeBytes: number;
  totalBytes: number;
  freeFraction: number;
  perRoot: Array<{ root: string; freeBytes: number; totalBytes: number }>;
  sampledAt: string;
};

export type DiskPressureThresholds = {
  exhaustedBytes: number;
  criticalBytes: number;
  criticalFraction: number;
  warningBytes: number;
  warningFraction: number;
};

export function isUrgentDiskPressure(state: DiskPressureState): boolean {
  return state === "critical" || state === "exhausted";
}

export type StorageCategoryId =
  | "chats_history"
  | "lanes_worktrees"
  | "build_release"
  | "caches"
  | "proof_attachments"
  | "recovery_backups"
  | "database";

export type StorageSafety = "safe_to_remove" | "compressible" | "review_first" | "protected";

export type StorageItem = {
  id: string;
  label: string;
  path: string;
  bytes: number;
  fileCount: number;
  lastModifiedAt: string | null;
  safety: StorageSafety;
  detail?: string;
  laneStatus?: "active" | "archived" | "orphaned";
  ownership?: "ADE-managed" | "Project-owned" | "System temporary";
  blockedReasons?: string[];
  reclaimableBytes?: number;
  ageHours?: number | null;
  laneId?: string;
  reclaimState?: "kept" | "ready_for_review" | "reclaimed" | "failed";
  /**
   * The scan ran out of its budget inside this item, so `bytes` is a lower
   * bound ("at least"), not the size. Absent on a fully measured item.
   */
  partial?: boolean;
  /**
   * A lane folder whose build output ADE removed while the lane sat idle and
   * that has not all come back yet. Absent on older builds and on lanes with
   * nothing removed.
   */
  buildOutputRemoved?: { at: string; bytes: number; partial?: boolean; folders: string[] };
};

export type StorageCategorySnapshot = {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  safety: StorageSafety;
  items: StorageItem[];
  compressibleBytes?: number;
  compressedBytes?: number;
  /** Some item in this category was not fully measured: `bytes` is a lower bound. */
  partial?: boolean;
  /**
   * How many items the category holds. `items` is capped for display; the
   * totals above always cover every item, so a cap never under-counts.
   */
  itemCount?: number;
};

export type StorageCompressionResult = {
  filesCompressed: number;
  savedBytes: number;
};

export type StorageSnapshot = {
  generatedAt: string;
  projectRoot: string;
  volume: { freeBytes: number; totalBytes: number };
  totalAdeBytes: number;
  categories: StorageCategorySnapshot[];
  scanDurationMs: number;
  /**
   * Some sizes are lower bounds because the scan ran out of budget (see each
   * category's and item's `partial`). Never set just because a list was capped.
   */
  truncated: boolean;
  // Optional so pre-overhaul snapshots (and the daemon-backed fallback
  // instance) remain valid; renderer must treat absence as "not available".
  extras?: StorageSnapshotExtras;
  lifecycle?: StorageLifecycleSnapshot;
};

export type StorageLifecycleSnapshot = {
  lastScanAt: string | null;
  nextScanAt: string | null;
  scanInProgress: boolean;
  policy: {
    maxActiveLanes: number;
    cleanupIntervalHours: number;
    autoArchiveAfterHours: number;
    reclaimArchivedAfterHours: number;
    /** Days a lane sits idle before its build output is removed; 0 = off. Absent on older builds. */
    cleanBuildOutputAfterDays?: number;
  };
  archivedAutomatically: number;
  reviewReadyCount: number;
  /** What the idle-lane build output cleanup removed. Absent on older builds. */
  buildOutput?: LaneBuildOutputSummary;
};

/** `laneCleanup.cleanBuildOutputAfterDays` when local.yaml does not set it: on, at a week. */
export const DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS = 7;

/** One lane's most recent build output cleanup. */
export type LaneBuildOutputLaneEntry = {
  laneId: string;
  laneName: string;
  /** When that cleanup ran. */
  removedAt: string;
  /** Bytes it freed in this lane. A lower bound when `partial`. */
  bytes: number;
  partial?: boolean;
  /** Folders removed, relative to the lane folder, with `/` separators. */
  folders: string[];
  /** Folders it tried to remove and could not, with a plain reason. */
  failures: Array<{ folder: string; reason: string }>;
};

export type LaneBuildOutputSummary = {
  /** The last time ADE checked idle lanes for build output, or null when it never has. */
  lastCheckAt: string | null;
  /** Everything removed since `since`, across every lane. */
  totalFreedBytes: number;
  totalPartial?: boolean;
  /** The oldest cleanup still on record, or null when there are none. */
  since: string | null;
  /** Newest first. */
  lanes: LaneBuildOutputLaneEntry[];
};

export type StorageCleanupTarget =
  | { kind: "orphaned_worktree"; path: string }
  | { kind: "archived_lane_worktree"; laneId: string; path: string }
  | { kind: "stale_tmp_staging"; path: string }
  | { kind: "rebuildable_cache"; path: string }
  | { kind: "recovery_backup"; path: string }
  // Screenshots, recordings, and attachments under `.ade/artifacts` or
  // `.ade/attachments`. Removing these also drops the matching proof records,
  // so the drawer never lists an item whose bytes are gone.
  | { kind: "proof_attachments"; path: string }
  // Transcripts and records of chats whose lane was deleted (the session rows
  // went with the lane; nothing in ADE opens them again). `path` is the
  // project's chat transcript directory; only qualifying files inside it are
  // removed, never the directory.
  | { kind: "deleted_lane_chats"; path: string }
  // The Claude and Codex session files ADE started for those chats, in the
  // providers' own folders. `path` is the project's chat-session record
  // directory (where the provider session ids are read from); only the
  // providers' files are removed, never that directory.
  | { kind: "deleted_lane_provider_sessions"; path: string };

/** `StorageItem.id` of the "Chats from deleted lanes" row in the chats & history category. */
export const DELETED_LANE_CHATS_ITEM_ID = "chats_history:deleted_lane_chats";

export type StorageCleanupPreview = {
  // `identity` binds a confirmation to the exact file generation the user
  // previewed (dev/ino/size/mtime fingerprint). Cleanup validates against the
  // submitted preview's identities, never against later previews of the same
  // path, so a stale confirm can never remove an unseen generation.
  items: Array<{ path: string; bytes: number; label: string; identity?: string }>;
  totalBytes: number;
  blocked: Array<{ path: string; reason: string }>;
};

export type StorageCleanupResult = {
  removed: Array<{ path: string; bytes: number }>;
  failed: Array<{ path: string; reason: string }>;
  freedBytes: number;
};

export type StoragePolicyClass = "user_data" | "derived" | "operational";

export type StorageLedgerPolicy = {
  maxAgeDays?: number;
  maxRows?: number;
  maxBytes?: number;
  compressAfterDays?: number;
  keepLatest?: number;
};

export type StorageLedgerEntry = {
  id: string;
  kind: "table" | "directory" | "file_family";
  description: string;
  policyClass: StoragePolicyClass;
  policy: StorageLedgerPolicy;
  enforcement: "write_time" | "doctor" | "both" | "manual";
};

/** What one storage-doctor step did. */
export type MaintenanceStepResult = {
  itemsAffected: number;
  bytesReclaimed: number;
  skippedReason?: string | null;
};

export type MaintenanceActionKind =
  | "prune"
  | "compress"
  | "delete"
  | "vacuum"
  | "compact"
  | "checkpoint";

export type MaintenanceAction = {
  ledgerId: string;
  kind: MaintenanceActionKind;
  itemsAffected: number;
  bytesReclaimed: number;
  durationMs: number;
  skippedReason?: string | null;
  error?: string | null;
};

export type MaintenanceTrigger = "daily" | "post_boot" | "manual" | "post_migration";

export type MaintenanceRunReport = {
  startedAt: string;
  finishedAt: string;
  trigger: MaintenanceTrigger;
  actions: MaintenanceAction[];
  /**
   * Everything the run freed: files removed, database space returned and
   * history compression savings. Each action carries its own share.
   */
  reclaimedBytes: number;
  /** Database size after the run. See `dbSizeDefinition`. */
  dbSizeBytes: number | null;
  /**
   * "files": the main database file plus its `-wal` and `-shm` files, the
   * same definition the storage snapshot uses. Absent on older runs, which
   * measured the main file only; those samples are not comparable.
   */
  dbSizeDefinition?: "files";
  /**
   * A run that only removed files the person confirmed in Settings (no
   * database or history work). A manual maintenance run that follows within
   * minutes folds into it, so one "Clean up" reads as one run.
   */
  filesOnly?: boolean;
};

export type DbBreakdownCategory =
  | "webhooks"
  | "sync_bookkeeping"
  | "pr_cache"
  | "core";

export type DbBreakdownEntry = {
  table: string;
  label: string;
  bytes: number;
  category: DbBreakdownCategory;
  action: "prunable" | "compactable" | "compaction_pending" | null;
};

export type StorageMaintenanceInfo = {
  lastRun: MaintenanceRunReport | null;
  journal: MaintenanceRunReport[];
};

export type StorageSnapshotExtras = {
  dbBreakdown: DbBreakdownEntry[];
  maintenance: StorageMaintenanceInfo;
  safeReclaimableBytes: number;
  policyChips: Partial<Record<StorageCategoryId, string>>;
  /** Each agent provider's own session history on this machine (all projects). Absent on older builds. */
  providerHistory?: ProviderHistoryEntry[];
  /** Provider session files ADE started for this project's chats from deleted lanes. Absent when there are none. */
  deletedLaneProviderCopies?: { chatCount: number; bytes: number; chatSessionsDir: string };
};

export type ProviderHistoryEntry = {
  provider: string;
  label: string;
  /** The provider's own folders that were measured. */
  paths: string[];
  bytes: number;
  fileCount: number;
  /** The scan stopped early; `bytes` is a lower bound. */
  partial?: boolean;
  /** Who manages these files and how long they are kept. */
  note: string;
};

/** What the deleted-chats reminder needs: cheap to compute, no full storage scan. */
export type DeletedLaneChatsSummary = {
  chatCount: number;
  bytes: number;
  /** Where the transcripts are on the machine that owns the project. */
  directory: string;
};

export type RuntimeHealthSnapshot = {
  /**
   * Background service calls that succeeded but took over 500 ms in the last
   * 24 h. Storage and project-health scans are excluded: they are slow by
   * design, and opening Settings → Overview would otherwise count itself.
   */
  slowActions24h: number;
  /** 95th percentile duration of those slow calls, in ms. */
  slowActionP95Ms: number | null;
  /** Calls that failed in the last 24 h (same exclusions). Absent on older builds. */
  failedActions24h?: number;
  sampledAt: string;
};
