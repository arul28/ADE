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
};

export type StorageCleanupTarget =
  | { kind: "orphaned_worktree"; path: string }
  | { kind: "archived_lane_worktree"; laneId: string; path: string }
  | { kind: "stale_tmp_staging"; path: string }
  | { kind: "rebuildable_cache"; path: string }
  | { kind: "recovery_backup"; path: string };

export type StorageCleanupPreview = {
  items: Array<{ path: string; bytes: number; label: string }>;
  totalBytes: number;
  blocked: Array<{ path: string; reason: string }>;
};

export type StorageCleanupResult = {
  removed: Array<{ path: string; bytes: number }>;
  failed: Array<{ path: string; reason: string }>;
  freedBytes: number;
};
