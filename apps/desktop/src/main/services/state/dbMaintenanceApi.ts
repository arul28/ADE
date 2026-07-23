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
/**
 * Hard ceiling on TOTAL ingress rows per project regardless of status. Well
 * above the 2,000 active-row cap so normal dedup/audit history survives, but
 * bounds dispatched/failed rows so an always-on brain dispatching high webhook
 * volume can't bloat automation_ingress_events within the 7-day window and
 * wedge the cr-sqlite table rebuild.
 */
export const INGRESS_EVENT_HARD_MAX_ROWS_PER_PROJECT = 10_000;
/** Review artifacts older than this (in days) are deleted. */
export const REVIEW_ARTIFACT_RETENTION_DAYS = 30;
/** PR snapshots not updated within this many days are deleted. */
export const PR_SNAPSHOT_RETENTION_DAYS = 60;

/**
 * Run the two ingress-event overflow DELETEs for a single project and return
 * the total rows removed. The caps work together:
 *
 *  1. Active cap — keep only the newest {@link INGRESS_EVENT_MAX_ROWS_PER_PROJECT}
 *     NON-dispatched rows. Dispatched/failed rows are exempt so redelivered
 *     webhooks still dedupe against their prior (project_id, source, event_key)
 *     even after their action completed or failed.
 *  2. Hard cap — because that exemption would otherwise leave dispatched/failed
 *     rows bounded only by the 7-day age prune, an always-on brain dispatching
 *     high webhook volume could accumulate effectively unbounded rows inside the
 *     window and wedge the cr-sqlite table rebuild. So trim TOTAL rows (any
 *     status) down to {@link INGRESS_EVENT_HARD_MAX_ROWS_PER_PROJECT}, deleting
 *     the oldest by received_at. Safe: the relay cursor advances, so old
 *     dispatched rows carry no live dedup value.
 *
 * The single source of truth for this SQL: both the automation ingress writer
 * (inside its begin-immediate insert path) and the storage-doctor maintenance
 * mirror call this so the caps can never drift. `deleteRows` executes one
 * parameterized DELETE and reports its change count — kvDb passes
 * `runStatement(...).changes`; the automation writer's `AdeDb.run` reports no
 * count, so it returns 0 and the caller ignores the total.
 */
export function pruneIngressEventRowsForProject(
  deleteRows: (sql: string, params: string[]) => number,
  projectId: string,
): number {
  let removed = 0;
  removed += deleteRows(
    `delete from automation_ingress_events
        where rowid in (
          select rowid
          from automation_ingress_events
          where project_id = ? and status not in ('dispatched', 'failed')
          order by received_at desc, rowid desc
          limit -1 offset ${INGRESS_EVENT_MAX_ROWS_PER_PROJECT}
        )`,
    [projectId],
  );
  removed += deleteRows(
    `delete from automation_ingress_events
        where rowid in (
          select rowid
          from automation_ingress_events
          where project_id = ?
          -- Keep active (non-terminal) rows first so the hard cap only ever
          -- trims the oldest terminal rows. An active 'received' row that is
          -- still being matched/dispatched must survive — dropping it would lose
          -- its audit record and break redelivery dedup (risking a double-run).
          order by (status not in ('dispatched', 'failed')) desc, received_at desc, rowid desc
          limit -1 offset ${INGRESS_EVENT_HARD_MAX_ROWS_PER_PROJECT}
        )`,
    [projectId],
  );
  return removed;
}

export type DbMaintenanceResult = {
  itemsAffected: number;
  bytesReclaimed: number;
  skippedReason?: "has_peers" | "below_threshold" | "unsupported" | null;
};

export interface DbMaintenanceApi {
  /**
   * Age-prune all ingress rows, cap non-dispatched rows at 2,000 per project,
   * then hard-cap TOTAL rows (any status) at 10,000 per project.
   */
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
