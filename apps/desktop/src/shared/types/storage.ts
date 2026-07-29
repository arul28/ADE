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
};

export type StorageCategorySnapshot = {
  id: StorageCategoryId;
  bytes: number;
  fileCount: number;
  safety: StorageSafety;
  items: StorageItem[];
  compressibleBytes?: number;
  compressedBytes?: number;
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
  };
  archivedAutomatically: number;
  reviewReadyCount: number;
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
  | { kind: "proof_attachments"; path: string };

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
  reclaimedBytes: number;
  dbSizeBytes: number | null;
};

export type DbBreakdownCategory =
  | "webhooks"
  | "sync_bookkeeping"
  | "review_artifacts"
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
};

export type RuntimeHealthSnapshot = {
  slowActions24h: number;
  slowActionP95Ms: number | null;
  sampledAt: string;
};
