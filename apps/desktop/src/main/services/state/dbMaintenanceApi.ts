// Interface for DB retention/maintenance hooks the storage doctor invokes.
// Implemented by kvDb (attached to the KvDb handle as `maintenance`); consumed
// by storageInsightsService via optional chaining so the doctor degrades
// gracefully on handles that predate the implementation.

// Single source of truth for the retention/count bounds enforced across the
// automation ingress writer, the kvDb maintenance hooks, and the storage
// ledger. Hoisted here so a policy change updates every enforcement site and
// the Settings copy in lockstep.
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Machine-local cron occurrence claims older than this are pruned at claim time. */
export const AUTOMATION_SCHEDULE_OCCURRENCE_RETENTION_DAYS = 35;
export const AUTOMATION_SCHEDULE_OCCURRENCE_RETENTION_MS =
  AUTOMATION_SCHEDULE_OCCURRENCE_RETENTION_DAYS * DAY_MS;
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

/** Linear/worker/pack/CTO event-log rows older than this are deleted. */
export const EVENT_LOG_RETENTION_DAYS = 30;

// --- Plugin data budgets --------------------------------------------------
//
// The plugin tables are the first schema ADE ships whose rows are authored by
// third-party code. Every other table has a writer we control, so a runaway
// row count is a bug we can fix; here it is an input. That inverts the usual
// enforcement order: the caps below are enforced IN THE WRITER, inside the same
// transaction as the insert, and a write that would exceed one is REJECTED
// rather than accepted-then-pruned.
//
// Rejecting is the whole point. `plugin_collections` and `plugin_contributions`
// are cr-sqlite CRRs, so each row also materializes clock and primary-key shadow
// rows that no prune reclaims — `compactCrsqlTombstones` only ever rebuilds
// `operations`, and it refuses to run at all while the project has sync peers.
// Accepting a write and pruning it later would therefore leave the shadow behind
// and ship it to every peer on the account before the prune ran.
//
// The doctor pass (`prunePluginData`) is a floor, not the enforcement: it exists
// for rows a crashed writer left behind and for plugins that have been
// uninstalled, not to make room for a plugin that is over budget.

/** Total `value_json` bytes one plugin may hold across all its collections. */
export const PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN = 2 * 1024 * 1024;
/** Rows one plugin may hold in `plugin_collections`, across all collections. */
export const PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN = 4_000;
/** Bytes of a single `plugin_collections.value_json`. */
export const PLUGIN_COLLECTION_VALUE_MAX_BYTES = 64 * 1024;
/** Materialized socket outputs one plugin may hold in `plugin_contributions`. */
export const PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN = 2_000;
/** Bytes of a single `plugin_contributions.payload_json`. */
export const PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES = 4 * 1024;
/** Panels one plugin may declare. */
export const PLUGIN_PANELS_MAX_PER_PLUGIN = 32;
/** Bytes of a single `plugin_panels.schema_json` (matches the vocabulary limit). */
export const PLUGIN_PANEL_SCHEMA_MAX_BYTES = 64 * 1024;
/** Per-plugin wire-meter rollups older than this are deleted. */
export const PLUGIN_WIRE_METER_RETENTION_DAYS = 45;

/**
 * Error code every budget rejection carries, on both the SDK and wire paths.
 *
 * Re-exported rather than declared: it is one string, and the SDK module is the
 * one place every consumer of it can already import from. Sync-side callers
 * that reach the budgets through this module keep reaching the code here too.
 */
export { PLUGIN_BUDGET_EXCEEDED_CODE } from "../../../shared/plugins/sdk";

/**
 * Delete rows belonging to plugins that are no longer present in
 * `plugin_presence` for this machine, plus meter rollups past their window.
 *
 * Deliberately keyed on presence rather than on age: plugin rows are user data
 * for as long as the plugin is installed, and a plugin that syncs once a month
 * must not lose its collection because nothing wrote to it. `presentPluginIds`
 * is the caller's machine-local install registry — an EMPTY set means "this
 * machine has no plugins", which is a legitimate state (nothing installed) and
 * deletes every plugin row, so callers that cannot read the registry must skip
 * the prune rather than pass an empty set.
 *
 * `deleteRows` executes one parameterized DELETE and reports its change count,
 * mirroring {@link pruneIngressEventRowsForProject}.
 */
export function prunePluginRowsForAbsentPlugins(
  deleteRows: (sql: string, params: string[]) => number,
  presentPluginIds: readonly string[],
  meterCutoffDay: string,
): number {
  const placeholders = presentPluginIds.map(() => "?").join(", ");
  const notPresent = presentPluginIds.length > 0
    ? `plugin_id not in (${placeholders})`
    : "1 = 1";
  const params = [...presentPluginIds];
  let removed = 0;
  for (const table of ["plugin_collections", "plugin_contributions", "plugin_panels"]) {
    removed += deleteRows(`delete from ${table} where ${notPresent}`, params);
  }
  removed += deleteRows("delete from plugin_wire_meter_daily where day < ?", [meterCutoffDay]);
  return removed;
}

/**
 * Rows deleted per batch by {@link pruneRowsInBatches}.
 *
 * ADE's SQLite driver (`node:sqlite` `DatabaseSync`) is fully synchronous, so a
 * DELETE runs to completion on the event loop with nothing else able to
 * proceed. 2,000 rows is small enough that one batch is imperceptible and
 * large enough that a realistic backlog clears in a handful of them.
 */
export const MAINTENANCE_DELETE_BATCH_ROWS = 2_000;

/** Batches per prune, so one call cannot run unbounded on a huge backlog. */
export const MAINTENANCE_DELETE_MAX_BATCHES = 200;

/**
 * Delete rows matching `where` in paced batches, yielding to the event loop
 * between them.
 *
 * Every existing prune issues a single unbounded DELETE. That is fine at
 * today's row counts and is a latency cliff waiting for the first project that
 * accumulates a real backlog: a synchronous driver means the UI, IPC, and sync
 * pump all stop for the duration. Batching bounds each pause; the `setImmediate`
 * between batches is what actually lets everything else run.
 *
 * Deleting by `rowid` rather than by the predicate keeps each batch's work
 * proportional to the batch, not to the table.
 */
export async function pruneRowsInBatches(args: {
  table: string;
  where: string;
  params: readonly unknown[];
  deleteRows: (sql: string, params: readonly unknown[]) => number;
  batchRows?: number;
  maxBatches?: number;
  yieldToEventLoop?: () => Promise<void>;
}): Promise<number> {
  const batchRows = args.batchRows ?? MAINTENANCE_DELETE_BATCH_ROWS;
  const maxBatches = args.maxBatches ?? MAINTENANCE_DELETE_MAX_BATCHES;
  const yieldToEventLoop = args.yieldToEventLoop
    ?? (() => new Promise<void>((resolve) => { setImmediate(resolve); }));

  const sql = `delete from ${args.table} where rowid in (
      select rowid from ${args.table} where ${args.where} limit ${batchRows}
    )`;
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const changes = args.deleteRows(sql, args.params);
    removed += changes;
    // A short batch means the predicate is exhausted; stop without paying for
    // one more round trip.
    if (changes < batchRows) break;
    await yieldToEventLoop();
  }
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
   * Delete rows older than 30 days from the append-only event logs that had no
   * retention at all: `linear_sync_events`, `linear_workflow_run_events`,
   * `worker_agent_cost_events`, and `pack_events`. Every one of them
   * replicates.
   *
   * `linear_ingress_events`, `cto_session_logs`, and `worker_agent_runs` look
   * like they belong here and deliberately do not — see
   * `RETAINED_EVENT_LOG_TABLES` in `kvDb.ts` for why pruning each would be a
   * bug.
   */
  pruneEventLogs(): Promise<DbMaintenanceResult>;
  /**
   * Reclaim cr-sqlite clock/pks bookkeeping. Only safe (and only performed)
   * when the project has zero sync peers; otherwise returns skippedReason
   * "has_peers" without touching anything.
   */
  compactCrsqlTombstones(): DbMaintenanceResult;
  /**
   * Delete plugin rows left behind by uninstalled plugins and expired wire-meter
   * rollups. A floor beneath the writer-enforced budgets, not a substitute:
   * `presentPluginIds` names the plugins this machine still has installed, and
   * the pass is skipped entirely (skippedReason "unsupported") when the caller
   * cannot supply that list — an empty list would otherwise read as "delete
   * everything".
   */
  prunePluginData(presentPluginIds: readonly string[] | null): DbMaintenanceResult;
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
