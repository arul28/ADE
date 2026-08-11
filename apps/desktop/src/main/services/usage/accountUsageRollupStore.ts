/**
 * accountUsageRollupStore.ts
 *
 * Durable, CRR-replicated storage for the per-machine usage rollups that the
 * account scope adds up. See the `usage_machine_rollups` migration in
 * `state/kvDb.ts` for why uniqueness is carried by the composite primary key.
 *
 * The store never holds a transcript record — only aggregates — and never
 * throws at the caller. A Usage page that cannot read its own cache should show
 * one machine's numbers, not an error.
 */

import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type {
  AdeUsageRollup,
  AdeUsageRollupRow,
  AdeUsageTranscriptSource,
} from "../../../shared/types";
import { getErrorMessage, safeJsonParse } from "../shared/utils";

/**
 * How far back a rollup publishes.
 *
 * The longest range preset is `year` (365 days). The extra month absorbs the
 * timezone skew between machines and the gap between a peer's last publish and
 * the day the reader asks about, so a year-long range is never short a day at
 * its far edge. Anything beyond that is history no preset can display, bought
 * with rows in a CRR-replicated table on every machine on the account.
 */
export const ROLLUP_RETAINED_DAYS = 400;

type RollupRowRecord = {
  machine_key: string;
  day: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  calls: number;
};

type RollupMetaRecord = {
  machine_key: string;
  label: string;
  platform: string | null;
  captured_at: string;
  source_id: string | null;
  source_roots: string;
};

/**
 * The `content_digest` and `source_window` columns are deliberately absent.
 * They fed the token-level source comparison that `isSameTranscriptSource` no
 * longer runs, and dropping a column from a cr-sqlite CRR table is a migration
 * risk with nothing to gain: both are `not null default ''`, so leaving them
 * unread and unwritten costs an empty string per machine.
 */
const META_COLUMNS = "machine_key, label, platform, captured_at, source_id, source_roots";

function parseStringArray(raw: unknown): string[] {
  const parsed = typeof raw === "string" ? safeJsonParse<unknown>(raw, null) : null;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

/** Numeric columns a row upsert would write, in one comparable shape. */
function rowFingerprint(row: {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cost_usd: number;
  calls: number;
}): string {
  return [
    Number(row.input_tokens) || 0,
    Number(row.output_tokens) || 0,
    Number(row.cached_tokens) || 0,
    Number(row.total_tokens) || 0,
    Number(row.cost_usd) || 0,
    Number(row.calls) || 0,
  ].join("|");
}

export function createAccountUsageRollupStore({ db, logger }: { db?: AdeDb | null; logger?: Logger }) {
  const warn = (event: string, error: unknown): void => {
    logger?.warn(event, { error: getErrorMessage(error) });
  };

  /**
   * Write a machine's rollup, and report whether anything actually changed.
   *
   * The return value is the load-bearing part. Callers use it to decide whether
   * to wake every usage subscriber, and "the statement did not throw" is not an
   * answer to that question: a live refresh that republishes byte-identical
   * history would emit an update, the renderer would re-read, that read would
   * start another refresh, and the page would spin for as long as it was open.
   * So this compares against what is stored and returns `true` only when a row
   * really moved or the machine's *identity* (label, platform, transcript
   * source) really changed. A refreshed `captured_at` is deliberately not a
   * change: it moves on every single publish, so counting it would reopen the
   * loop from the other side. `false` therefore means either "no change" or
   * "failed" — both of which are "nothing new to show".
   *
   * Rows that vanished from the scan (a pruned provider log, a day that aged
   * past the retention bound) are deleted individually rather than by rewriting
   * the whole machine's history, which would churn every CRR clock.
   *
   * `skipReconcileProviders` names providers whose scan *failed* this round.
   * Their absence from `rows` is a scan error, not a removal, and it is the same
   * reasoning as the zero-row guard one level finer: without it a single flaky
   * mount deletes up to `ROLLUP_RETAINED_DAYS` of that provider's history for
   * this machine, and because these are CRR tables the deletes replicate to
   * every machine on the account.
   *
   * `ownerAuthoritative: false` marks a rollup this machine *fetched from a
   * peer* rather than built from its own scan. Only the owner knows which of
   * its providers failed: a failed provider is absent from `scanResult.costs`
   * by construction, so it is absent from what `getUsageRollup` hands a peer,
   * and the fetching machine has no `skipReconcileProviders` to pass. Without
   * this flag machine A fetches B, sees B's Claude rows as vanished, deletes
   * them under `machine_key = B` — and the delete replicates back to B and
   * account-wide, undoing exactly the protection B applied to itself. So a
   * non-owner never deletes a provider that is entirely absent from the payload
   * it received: absence there is ambiguous (removed vs scan failed) and only
   * the owner can resolve it. A provider that *is* present still reconciles
   * normally, so genuine removals within a reported provider still land.
   */
  function publish(
    rollup: AdeUsageRollup,
    options: {
      skipReconcileProviders?: readonly string[] | ReadonlySet<string>;
      ownerAuthoritative?: boolean;
    } = {},
  ): boolean {
    if (!db) return false;
    try {
      const rows = rollup.rows;
      const keys = new Set<string>();
      // A zero-row rollup is never evidence that history was removed — it is
      // what a machine answers while its first ledger scan is still running.
      // Reconciling against it would delete every stored day for that machine,
      // and because these are CRR tables the deletes would replicate to every
      // other machine on the account.
      const existing = rows.length === 0
        ? []
        : db.all<RollupRowRecord>(
          `select machine_key, day, provider, model, input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd, calls
             from usage_machine_rollups where machine_key = ?`,
          [rollup.machineKey],
        );
      const existingByKey = new Map<string, RollupRowRecord>();
      for (const record of existing) {
        existingByKey.set(`${record.day}\x00${record.provider}\x00${record.model}`, record);
      }
      let changed = false;

      for (const row of rows) {
        const rowKey = `${row.date}\x00${row.provider}\x00${row.model}`;
        keys.add(rowKey);
        const stored = existingByKey.get(rowKey);
        const incoming = {
          input_tokens: row.inputTokens,
          output_tokens: row.outputTokens,
          cached_tokens: row.cachedTokens,
          total_tokens: row.totalTokens,
          cost_usd: row.costUsd,
          calls: row.calls,
        };
        // Skipping the statement outright, not just its effect: an upsert whose
        // `where` clause matches nothing still costs a prepare and a page read
        // per row, and a year of history is thousands of rows per refresh.
        if (stored && rowFingerprint(stored) === rowFingerprint(incoming)) continue;
        changed = true;
        db.run(
          `insert into usage_machine_rollups
             (machine_key, day, provider, model, input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd, calls)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(machine_key, day, provider, model) do update set
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             cached_tokens = excluded.cached_tokens,
             total_tokens = excluded.total_tokens,
             cost_usd = excluded.cost_usd,
             calls = excluded.calls
           where usage_machine_rollups.total_tokens <> excluded.total_tokens
              or usage_machine_rollups.input_tokens <> excluded.input_tokens
              or usage_machine_rollups.output_tokens <> excluded.output_tokens
              or usage_machine_rollups.cached_tokens <> excluded.cached_tokens
              or usage_machine_rollups.cost_usd <> excluded.cost_usd
              or usage_machine_rollups.calls <> excluded.calls`,
          [
            rollup.machineKey,
            row.date,
            row.provider,
            row.model,
            row.inputTokens,
            row.outputTokens,
            row.cachedTokens,
            row.totalTokens,
            row.costUsd,
            row.calls,
          ],
        );
      }

      const skipProviders = options.skipReconcileProviders instanceof Set
        ? options.skipReconcileProviders
        : new Set(options.skipReconcileProviders ?? []);
      // Only meaningful for a peer publish; the owner reconciles every provider.
      const reportedProviders = options.ownerAuthoritative === false
        ? new Set(rows.map((row) => row.provider))
        : null;
      for (const [rowKey, record] of existingByKey) {
        if (keys.has(rowKey)) continue;
        // This provider did not report at all this round because its scan
        // threw. Silence from a failed scan is not a deletion.
        if (skipProviders.has(record.provider)) continue;
        // A non-owner cannot tell "the owner removed this provider" from "the
        // owner's scan of it failed", so it deletes neither.
        if (reportedProviders && !reportedProviders.has(record.provider)) continue;
        changed = true;
        db.run(
          "delete from usage_machine_rollups where machine_key = ? and day = ? and provider = ? and model = ?",
          [rollup.machineKey, record.day, record.provider, record.model],
        );
      }

      const meta = {
        label: rollup.label,
        platform: rollup.platform,
        captured_at: rollup.capturedAt,
        source_id: rollup.source.sourceId,
        source_roots: JSON.stringify(rollup.source.roots),
      };
      const storedMeta = db.get<RollupMetaRecord>(
        `select ${META_COLUMNS} from usage_machine_rollup_meta where machine_key = ?`,
        [rollup.machineKey],
      );
      // Freshness is not a change. Every republish carries a new `capturedAt`,
      // so folding it into `changed` would make a byte-identical republish
      // report "changed" — which wakes every usage subscriber, makes the
      // renderer re-read, and starts the next refresh: the self-sustaining
      // loop this return value exists to break. The fresh timestamp is still
      // written (peers rank a machine's rollup by it, and the page shows it as
      // "last reported"); it just does not, on its own, mean there is anything
      // new to show.
      const identityChanged = !storedMeta
        || storedMeta.label !== meta.label
        || (storedMeta.platform ?? null) !== (meta.platform ?? null)
        || (storedMeta.source_id ?? null) !== (meta.source_id ?? null)
        || storedMeta.source_roots !== meta.source_roots;
      const metaChanged = identityChanged || storedMeta?.captured_at !== meta.captured_at;
      if (identityChanged) changed = true;
      if (metaChanged) {
        db.run(
          `insert into usage_machine_rollup_meta
             (machine_key, label, platform, captured_at, source_id, source_roots)
           values (?, ?, ?, ?, ?, ?)
           on conflict(machine_key) do update set
             label = excluded.label,
             platform = excluded.platform,
             captured_at = excluded.captured_at,
             source_id = excluded.source_id,
             source_roots = excluded.source_roots`,
          [
            rollup.machineKey,
            meta.label,
            meta.platform,
            meta.captured_at,
            meta.source_id,
            meta.source_roots,
          ],
        );
      }
      return changed;
    } catch (error) {
      warn("usage.account.rollup_publish_failed", error);
      return false;
    }
  }

  /** Every machine's stored rollup, including this one's. Never throws. */
  function readAll(): AdeUsageRollup[] {
    if (!db) return [];
    try {
      const meta = db.all<RollupMetaRecord>(
        `select ${META_COLUMNS} from usage_machine_rollup_meta`,
      );
      if (meta.length === 0) return [];
      const rowsByMachine = new Map<string, AdeUsageRollupRow[]>();
      const rows = db.all<RollupRowRecord>(
        `select machine_key, day, provider, model, input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd, calls
           from usage_machine_rollups`,
      );
      for (const record of rows) {
        let bucket = rowsByMachine.get(record.machine_key);
        if (!bucket) {
          bucket = [];
          rowsByMachine.set(record.machine_key, bucket);
        }
        bucket.push({
          date: record.day,
          provider: record.provider,
          model: record.model,
          inputTokens: Number(record.input_tokens) || 0,
          outputTokens: Number(record.output_tokens) || 0,
          cachedTokens: Number(record.cached_tokens) || 0,
          totalTokens: Number(record.total_tokens) || 0,
          costUsd: Number(record.cost_usd) || 0,
          calls: Number(record.calls) || 0,
        });
      }
      return meta.map((record): AdeUsageRollup => {
        const source: AdeUsageTranscriptSource = {
          sourceId: record.source_id || null,
          roots: parseStringArray(record.source_roots),
        };
        return {
          version: 1,
          machineKey: record.machine_key,
          label: record.label || record.machine_key,
          platform: record.platform || null,
          capturedAt: record.captured_at || "",
          source,
          rows: rowsByMachine.get(record.machine_key) ?? [],
        };
      });
    } catch (error) {
      warn("usage.account.rollup_read_failed", error);
      return [];
    }
  }

  /** Drop rows older than the retention bound. Cheap, index-backed, best effort. */
  function prune(oldestDayKey: string): void {
    if (!db || !oldestDayKey) return;
    try {
      db.run("delete from usage_machine_rollups where day < ?", [oldestDayKey]);
    } catch (error) {
      warn("usage.account.rollup_prune_failed", error);
    }
  }

  return { publish, readAll, prune };
}

export type AccountUsageRollupStore = ReturnType<typeof createAccountUsageRollupStore>;
