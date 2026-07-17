// Pure helpers that turn raw dbstat rows into the coarse "project database"
// breakdown shown in Settings, plus the derivation of the sync-bookkeeping
// action from the maintenance journal. Extracted from storageInsightsService so
// the mapping logic is unit-testable on its own and free of filesystem/db deps.

import type { DbBreakdownEntry, MaintenanceRunReport } from "../../../shared/types/storage";

type DbBreakdownCategoryKey = DbBreakdownEntry["category"];

export const DB_BREAKDOWN_META: Record<
  DbBreakdownCategoryKey,
  { label: string; table: string; action: DbBreakdownEntry["action"] }
> = {
  webhooks: { label: "Webhook history", table: "automation_ingress_events", action: "prunable" },
  sync_bookkeeping: { label: "Sync bookkeeping", table: "operations__crsql", action: "compactable" },
  review_artifacts: { label: "Review artifacts", table: "review_run_artifacts", action: "prunable" },
  pr_cache: { label: "PR cache", table: "pull_request_snapshots", action: "prunable" },
  core: { label: "Core data", table: "core", action: null },
};

/** Classify a dbstat table/index name into a coarse storage-breakdown category. */
export function classifyDbTable(name: string): DbBreakdownCategoryKey {
  const lower = name.toLowerCase();
  if (lower.startsWith("operations__crsql")) return "sync_bookkeeping";
  if (lower.includes("automation_ingress_events")) return "webhooks";
  if (lower.includes("review_run_artifacts")) return "review_artifacts";
  if (lower.includes("pull_request_snapshots")) return "pr_cache";
  return "core";
}

/**
 * Aggregate raw dbstat rows into one breakdown entry per non-empty category.
 * `overrides.syncBookkeeping` lets the caller replace the static
 * "compactable" label with the journal-derived state (see
 * `deriveSyncBookkeepingAction`) so paired projects read "compaction_pending".
 */
export function mapDbBreakdown(
  rows: Array<{ name: string; bytes: number }>,
  overrides?: { syncBookkeeping?: DbBreakdownEntry["action"] },
): DbBreakdownEntry[] {
  const totals = new Map<DbBreakdownCategoryKey, number>();
  for (const row of rows) {
    if (!row || typeof row.name !== "string") continue;
    const bytes = typeof row.bytes === "number" && Number.isFinite(row.bytes) ? row.bytes : 0;
    const category = classifyDbTable(row.name);
    totals.set(category, (totals.get(category) ?? 0) + Math.max(0, bytes));
  }
  const entries: DbBreakdownEntry[] = [];
  for (const [category, bytes] of totals) {
    if (bytes <= 0) continue;
    const meta = DB_BREAKDOWN_META[category];
    const action = category === "sync_bookkeeping" && overrides?.syncBookkeeping !== undefined
      ? overrides.syncBookkeeping
      : meta.action;
    entries.push({ table: meta.table, label: meta.label, bytes, category, action });
  }
  return entries.sort((left, right) => right.bytes - left.bytes || left.table.localeCompare(right.table));
}

/**
 * Sync-bookkeeping compaction state, derived without any new seam. We only
 * surface an actionable "Compact now" ("compactable") once the journal proves
 * the most recent run's cr-sqlite compaction actually executed without a
 * has_peers skip. With no journal yet — or no compact record in the latest run
 * — there is no positive evidence that compaction is safe, so we default to
 * "compaction_pending" ("Waiting to compact") rather than offer an action that
 * might turn out to be peer-blocked. A latest run peer-blocked stays pending.
 */
export function deriveSyncBookkeepingAction(
  journal: readonly MaintenanceRunReport[],
): DbBreakdownEntry["action"] {
  const lastCompact = journal[0]?.actions.find((action) => action.ledgerId === "db.operations_crsql");
  if (!lastCompact) return "compaction_pending";
  return lastCompact.skippedReason === "has_peers" ? "compaction_pending" : "compactable";
}
