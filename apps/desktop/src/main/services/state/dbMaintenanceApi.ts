// Interface for DB retention/maintenance hooks the storage doctor invokes.
// Implemented by kvDb (attached to the KvDb handle as `maintenance`); consumed
// by storageInsightsService via optional chaining so the doctor degrades
// gracefully on handles that predate the implementation.

// Single source of truth for the retention/count bounds enforced across the
// automation ingress writer, the kvDb maintenance hooks, and the storage
// ledger. Hoisted here so a policy change updates every enforcement site and
// the Settings copy in lockstep.
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Automation ingress events older than this are pruned (write-time + doctor). */
export const INGRESS_EVENT_RETENTION_MS = 7 * DAY_MS;
/** Newest non-dispatched ingress rows kept per project after age pruning. */
export const INGRESS_EVENT_MAX_ROWS_PER_PROJECT = 2_000;
/** Review artifacts older than this (in days) are deleted. */
export const REVIEW_ARTIFACT_RETENTION_DAYS = 30;
/** PR snapshots not updated within this many days are deleted. */
export const PR_SNAPSHOT_RETENTION_DAYS = 60;

export type DbMaintenanceResult = {
  itemsAffected: number;
  bytesReclaimed: number;
  skippedReason?: "has_peers" | "below_threshold" | "unsupported" | null;
};

export interface DbMaintenanceApi {
  /** Age-prune all ingress rows, then cap non-dispatched rows at 2,000 per project. */
  pruneIngressEvents(): DbMaintenanceResult;
  /** Delete review_run_artifacts rows older than 30 days. */
  pruneReviewArtifacts(): DbMaintenanceResult;
  /** Delete pull_request_snapshots rows not updated in 60 days. */
  prunePrSnapshots(): DbMaintenanceResult;
  /**
   * Reclaim cr-sqlite clock/pks bookkeeping. Only safe (and only performed)
   * when the project has zero sync peers; otherwise returns skippedReason
   * "has_peers" without touching anything.
   */
  compactCrsqlTombstones(): DbMaintenanceResult;
  /**
   * Full VACUUM (+ auto_vacuum=INCREMENTAL activation) when the freelist
   * fraction exceeds `threshold`; bounded incremental_vacuum chunks otherwise.
   * Returns bytes reclaimed on disk.
   */
  vacuumIfFragmented(threshold: number): DbMaintenanceResult;
}

export interface KvDbWithMaintenance {
  maintenance?: DbMaintenanceApi;
}
