/**
 * accountUsageRollup.ts
 *
 * Account scope: one page that adds up every machine on the ADE account.
 *
 * Two rules shape everything here.
 *
 * 1. **Aggregates only.** A machine publishes day × provider × model totals and
 *    nothing else. Raw transcript records never leave the machine that scanned
 *    them, never enter the sync layer, and are never held in memory here — the
 *    rollup for a heavy year of use is a few thousand small rows.
 *
 * 2. **Historical only.** Cost, tokens, code and PR history merge. The live
 *    quota windows do not: provider rate limits are tied to the provider
 *    account, not the machine, so every machine already reports the same
 *    window and "merging" them would either double a shared limit or imply a
 *    per-machine difference that does not exist.
 *
 * GitHub metrics are deliberately absent from the rollup. They are repo-scoped,
 * not machine-scoped: three machines with the same repo cloned each report the
 * same pull requests, and summing them would triple the PR count for work that
 * happened once. The account page therefore shows GitHub numbers from the local
 * machine only, and says so in `sourceNotes`.
 */

import type {
  AdeUsageMachineContribution,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRollup,
  AdeUsageRollupRow,
  AdeUsageStats,
  CostSnapshot,
} from "../../../shared/types";
import { localDayKey, localDayOrdinal } from "./localDay";
import { isSameTranscriptSource } from "./accountUsageSource";

/** A rollup older than this is still counted, but flagged so the UI can say it lags. */
export const ACCOUNT_ROLLUP_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** One machine's answer, before dedupe/staleness is decided. */
export type AccountUsageContribution = {
  machineKey: string;
  label: string;
  platform: string | null;
  isLocal: boolean;
  /** Null when this machine could not be reached and has no stored rollup. */
  rollup: AdeUsageRollup | null;
  /** Where the rollup came from: a live refresh, or the durable published copy. */
  origin: "live" | "rollup";
  /** Log-free reason to show when `rollup` is null. */
  message?: string | null;
};

type RangeBounds = { since: string | null; until: string };

function toNonNegativeInt(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function toNonNegativeNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

// ── Rollup construction ──────────────────────────────────────────

/**
 * Fold a machine's cost snapshots into day × provider × model rows.
 *
 * Reads the `all` preset because a rollup is a historical archive, not a view:
 * the machine publishing it does not know which range the reader will ask for.
 * Hosts too old to carry the per-model daily breakdown still publish flat daily
 * totals under a single `unknown` model rather than dropping the day.
 *
 * `oldestDay` bounds the archive at the store's retention edge, and it is not
 * cosmetic. The `all` preset spans `LOCAL_COST_SCAN_ALL_DAYS` (3650) days, while
 * `AccountUsageRollupStore.prune` deletes every row older than
 * `ROLLUP_RETAINED_DAYS` (400) on every publish. Without this bound the two ran
 * against each other once per scan cycle: prune deleted a decade of rows — for
 * *every* machine key, not just the local one — and publish immediately
 * re-inserted the local machine's copy because nothing stored remained to
 * fingerprint against. These are CRR tables, so each cycle replicated a full
 * delete-changeset and a full insert-changeset of pre-retention history to every
 * desktop on the account, forever, and retention bounded nothing. Callers must
 * pass the *same* key `prune` is called with so the two agree.
 */
export function buildRollupRows(
  costs: readonly CostSnapshot[],
  options: { oldestDay?: string | null } = {},
): AdeUsageRollupRow[] {
  const oldestDay = options.oldestDay || null;
  // Both sides are `YYYY-MM-DD`, which is lexicographically ordered, and this is
  // the same comparison `prune`'s `day < ?` makes in SQL.
  const beforeRetention = (date: string): boolean => oldestDay !== null && date < oldestDay;
  const rows: AdeUsageRollupRow[] = [];
  for (const cost of costs) {
    const provider = cost.provider || "unknown";
    const dailyBreakdown = cost.dailyTokenBreakdownByPreset?.all;
    if (dailyBreakdown) {
      for (const [date, models] of Object.entries(dailyBreakdown)) {
        if (!localDayKey(date)) continue;
        if (beforeRetention(date)) continue;
        for (const [model, tokens] of Object.entries(models)) {
          const inputTokens = toNonNegativeInt(tokens.input);
          const outputTokens = toNonNegativeInt(tokens.output);
          const cachedTokens = toNonNegativeInt(tokens.cached) + toNonNegativeInt(tokens.cacheWrite);
          const totalTokens = inputTokens + outputTokens + cachedTokens;
          const costUsd = toNonNegativeNumber(tokens.costUsd);
          if (totalTokens === 0 && costUsd === 0) continue;
          rows.push({
            date,
            provider,
            model: model || "unknown",
            inputTokens,
            outputTokens,
            cachedTokens,
            totalTokens,
            costUsd,
            calls: 0,
          });
        }
      }
      continue;
    }
    const flatDaily = cost.dailyTokensByPreset?.all;
    if (!flatDaily) continue;
    for (const [date, value] of Object.entries(flatDaily)) {
      if (!localDayKey(date)) continue;
      if (beforeRetention(date)) continue;
      const totalTokens = toNonNegativeInt(value);
      if (totalTokens === 0) continue;
      rows.push({
        date,
        provider,
        model: "unknown",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens,
        costUsd: 0,
        calls: 0,
      });
    }
  }
  return rows;
}

// ── Merge ────────────────────────────────────────────────────────

function dateInBounds(date: string, bounds: RangeBounds): boolean {
  const ordinal = localDayOrdinal(date);
  if (ordinal == null) return false;
  if (bounds.since) {
    const sinceOrdinal = localDayOrdinal(localDayKey(bounds.since));
    if (sinceOrdinal != null && ordinal < sinceOrdinal) return false;
  }
  const untilOrdinal = localDayOrdinal(localDayKey(bounds.until));
  if (untilOrdinal != null && ordinal > untilOrdinal) return false;
  return true;
}

type RollupTotals = { totalTokens: number; costUsd: number };

/**
 * Sum a rollup's in-range rows. Used both to report a machine's contribution
 * and to compute a deduped/failed machine's (zero) contribution consistently.
 */
export function summarizeRollupRange(
  rows: readonly AdeUsageRollupRow[],
  bounds: RangeBounds,
): RollupTotals {
  let totalTokens = 0;
  let costUsd = 0;
  for (const row of rows) {
    if (!dateInBounds(row.date, bounds)) continue;
    totalTokens += row.totalTokens;
    costUsd += row.costUsd;
  }
  return { totalTokens, costUsd: roundCents(costUsd) };
}

/**
 * Decide which machines count.
 *
 * Ordering is load-bearing: the local machine wins any dedupe (its numbers are
 * the freshest and its GitHub/DB context is the one on screen), then the most
 * recently captured rollup. Without a deterministic winner the same two
 * machines would swap places between renders and the totals would flicker.
 */
export function resolveContributions(
  contributions: readonly AccountUsageContribution[],
  bounds: RangeBounds,
  nowMs: number,
): { accepted: AccountUsageContribution[]; machines: AdeUsageMachineContribution[] } {
  const ordered = [...contributions].sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    const aAt = Date.parse(a.rollup?.capturedAt ?? "");
    const bAt = Date.parse(b.rollup?.capturedAt ?? "");
    return (Number.isFinite(bAt) ? bAt : 0) - (Number.isFinite(aAt) ? aAt : 0)
      || a.machineKey.localeCompare(b.machineKey);
  });

  const accepted: AccountUsageContribution[] = [];
  const machines: AdeUsageMachineContribution[] = [];
  // First accepted machine per marker. One entry is enough because equal
  // markers are the whole answer — see `isSameTranscriptSource` — so every
  // later machine under a marker dedupes against the same winner, and the
  // ordering above is what makes that winner deterministic.
  const bySourceId = new Map<string, AccountUsageContribution>();

  for (const entry of ordered) {
    const base = {
      machineKey: entry.machineKey,
      label: entry.label || entry.machineKey,
      platform: entry.platform ?? null,
      isLocal: entry.isLocal,
    };
    const rollup = entry.rollup;
    if (!rollup) {
      machines.push({
        ...base,
        state: "failed",
        lastReportedAt: null,
        totalTokens: 0,
        costUsd: 0,
        message: entry.message ?? "Couldn't reach this computer",
      });
      continue;
    }

    const duplicateOf = findDuplicate(rollup, accepted, bySourceId);
    if (duplicateOf) {
      machines.push({
        ...base,
        state: "deduped",
        lastReportedAt: rollup.capturedAt,
        dedupedAgainstMachineKey: duplicateOf.machineKey,
        totalTokens: 0,
        costUsd: 0,
        message: `Reads the same transcripts as ${duplicateOf.label || duplicateOf.machineKey}`,
      });
      continue;
    }

    accepted.push(entry);
    const acceptedSourceId = rollup.source?.sourceId;
    if (acceptedSourceId && !bySourceId.has(acceptedSourceId)) {
      bySourceId.set(acceptedSourceId, entry);
    }

    const capturedAtMs = Date.parse(rollup.capturedAt);
    const isStale = Number.isFinite(capturedAtMs)
      && nowMs - capturedAtMs > ACCOUNT_ROLLUP_STALE_AFTER_MS;
    const totals = summarizeRollupRange(rollup.rows, bounds);
    machines.push({
      ...base,
      state: entry.origin === "live" ? "live" : isStale ? "stale" : "rollup",
      lastReportedAt: rollup.capturedAt,
      totalTokens: totals.totalTokens,
      costUsd: totals.costUsd,
      ...(isStale && entry.origin !== "live"
        ? { message: "Showing this computer's last published numbers" }
        : {}),
    });
  }

  machines.sort((a, b) => (b.totalTokens - a.totalTokens) || a.label.localeCompare(b.label));
  return { accepted, machines };
}

function findDuplicate(
  rollup: AdeUsageRollup,
  accepted: readonly AccountUsageContribution[],
  bySourceId: Map<string, AccountUsageContribution>,
): AccountUsageContribution | null {
  const sourceId = rollup.source?.sourceId;
  if (sourceId) {
    // A matching marker is the answer, so this is the O(1) path a fleet of
    // marked machines actually takes.
    const marked = bySourceId.get(sourceId);
    if (marked) return marked;
    // Falling through rather than stopping here: an accepted machine that could
    // not read the marker this round (EACCES on the share, a capture from
    // before the marker was first written) carries no `sourceId` and so has no
    // `bySourceId` entry at all, yet `isSameTranscriptSource` fully supports a
    // marked/markerless pair via `roots`. Stopping at the map made dedupe
    // depend on which of the two happened to be processed first —
    // markerless-first doubled the totals, marked-first deduped — so a machine
    // oscillated between counted and deduped between refreshes. The extra scan
    // cannot over-match: two *different* markers short-circuit to false, so
    // only markerless candidates can be found here.
  }
  for (const candidate of accepted) {
    if (isSameTranscriptSource(rollup.source, candidate.rollup?.source)) return candidate;
  }
  return null;
}

/**
 * Add every accepted remote rollup into an already-computed local stats payload.
 *
 * Mutates and returns `stats`. Cost of the fold is O(machines × rows), where
 * rows is bounded by days × providers × models for the machine — every lookup
 * is a Map hit and no branch rescans a collection it has already walked.
 */
export function foldRollupsIntoStats(
  stats: AdeUsageStats,
  accepted: readonly AccountUsageContribution[],
  nowMs: number,
): AdeUsageStats {
  const bounds: RangeBounds = { since: stats.range.since, until: stats.range.until };
  const dailyByDate = new Map(stats.daily.map((point) => [point.date, point]));
  // Remote days outside the local skeleton are dropped rather than appended:
  // the skeleton already encodes the chart's day budget for the preset, and a
  // rollup reaching further back would silently stretch the axis.
  const firstDay = stats.daily[0]?.date ?? null;
  const lastDay = stats.daily[stats.daily.length - 1]?.date ?? null;
  const providerByName = new Map(stats.providers.map((entry) => [entry.provider, entry]));
  const modelByKey = new Map(stats.models.map((entry) => [`${entry.provider}\x00${entry.model}`, entry]));
  const todayKey = localDayKey(nowMs);
  const thirtyDaysAgoOrdinal = (localDayOrdinal(todayKey) ?? 0) - 29;

  let addedInput = 0;
  let addedOutput = 0;
  let addedCached = 0;
  let addedTotal = 0;
  let addedRangeCost = 0;

  for (const entry of accepted) {
    if (entry.isLocal) continue;
    const rollup = entry.rollup;
    if (!rollup) continue;

    for (const row of rollup.rows) {
      if (!dateInBounds(row.date, bounds)) continue;
      const inRangeCost = toNonNegativeNumber(row.costUsd);
      const provider = row.provider || "unknown";

      const point = firstDay && lastDay && row.date >= firstDay && row.date <= lastDay
        ? dailyByDate.get(row.date) ?? null
        : null;
      if (point) {
        point.inputTokens += row.inputTokens;
        point.outputTokens += row.outputTokens;
        point.cachedTokens = toNonNegativeInt(point.cachedTokens) + row.cachedTokens;
        point.totalTokens += row.totalTokens;
        if (row.totalTokens > 0 || inRangeCost > 0) {
          const byProvider = point.byProvider ?? (point.byProvider = {});
          const bucket = byProvider[provider];
          if (bucket) {
            bucket.totalTokens += row.totalTokens;
            bucket.costUsd += inRangeCost;
          } else {
            byProvider[provider] = { totalTokens: row.totalTokens, costUsd: inRangeCost };
          }
        }
      }

      let providerSummary = providerByName.get(provider);
      if (!providerSummary) {
        providerSummary = {
          provider,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          rangeCostUsd: 0,
          todayCostUsd: 0,
          last30dCostUsd: 0,
        };
        providerByName.set(provider, providerSummary);
        stats.providers.push(providerSummary);
      }
      providerSummary.inputTokens += row.inputTokens;
      providerSummary.outputTokens += row.outputTokens;
      providerSummary.cachedTokens += row.cachedTokens;
      providerSummary.totalTokens += row.totalTokens;
      // Accumulated raw and rounded once after the fold. Rounding inside the
      // loop compounds a half-cent of error per row, and a year of history at
      // three models a day is ~1,000 roundings for one machine.
      providerSummary.rangeCostUsd += inRangeCost;
      if (row.date === todayKey) providerSummary.todayCostUsd += inRangeCost;
      const rowOrdinal = localDayOrdinal(row.date);
      if (rowOrdinal != null && rowOrdinal >= thirtyDaysAgoOrdinal) {
        providerSummary.last30dCostUsd += inRangeCost;
      }

      const model = row.model || "unknown";
      const modelKey = `${provider}\x00${model}`;
      let modelSummary = modelByKey.get(modelKey);
      if (!modelSummary) {
        modelSummary = {
          provider,
          model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        };
        modelByKey.set(modelKey, modelSummary);
        stats.models.push(modelSummary);
      }
      modelSummary.calls += toNonNegativeInt(row.calls);
      modelSummary.inputTokens += row.inputTokens;
      modelSummary.outputTokens += row.outputTokens;
      modelSummary.cachedTokens += row.cachedTokens;
      modelSummary.totalTokens += row.totalTokens;
      modelSummary.costUsd += inRangeCost;

      addedInput += row.inputTokens;
      addedOutput += row.outputTokens;
      addedCached += row.cachedTokens;
      // Summed from `totalTokens` rather than from the input/output/cached
      // split, because a host too old to record the split still reports a
      // correct daily total — deriving the total from the parts would silently
      // drop every one of those machines' tokens.
      addedTotal += row.totalTokens;
      addedRangeCost += inRangeCost;
    }
  }

  // One rounding pass over the folded totals. Idempotent for the local rows,
  // which arrived already rounded at range level.
  for (const summary of stats.providers) {
    summary.rangeCostUsd = roundCents(summary.rangeCostUsd);
    summary.todayCostUsd = roundCents(summary.todayCostUsd);
    summary.last30dCostUsd = roundCents(summary.last30dCostUsd);
  }
  for (const summary of stats.models) {
    summary.costUsd = roundCents(summary.costUsd);
  }
  // The per-day provider buckets feed the stacked daily chart and its tooltip.
  // They accumulate raw above like every other total, so they need the same
  // single rounding pass — without it the chart is the one surface on the page
  // showing float drift.
  for (const point of stats.daily) {
    const byProvider = point.byProvider;
    if (!byProvider) continue;
    for (const bucket of Object.values(byProvider)) {
      bucket.costUsd = roundCents(bucket.costUsd);
    }
  }

  if (addedTotal > 0 || addedRangeCost > 0) {
    const addedTokens = addedTotal;
    stats.summary.observedProviderInputTokens += addedInput;
    stats.summary.observedProviderOutputTokens += addedOutput;
    stats.summary.observedProviderCachedTokens += addedCached;
    stats.summary.observedProviderTokens += addedTokens;
    stats.summary.observedProviderCostRangeUsd = roundCents(
      stats.summary.observedProviderCostRangeUsd + addedRangeCost,
    );
    stats.summary.observedProviderCost30dUsd = roundCents(
      sumBy(stats.providers, (entry) => entry.last30dCostUsd),
    );
    stats.summary.observedProviderCostTodayUsd = roundCents(
      sumBy(stats.providers, (entry) => entry.todayCostUsd),
    );
    stats.summary.totalTokens = stats.summary.observedProviderTokens > 0
      ? stats.summary.observedProviderTokens
      : stats.summary.totalTokens;
    if (stats.summary.observedProviderTokens > 0) {
      stats.summary.tokenTotalSource = "provider_logs";
    }
  }

  sortSummaries(stats);
  return stats;
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

function sortSummaries(stats: AdeUsageStats): void {
  stats.providers.sort((a: AdeUsageProviderSummary, b: AdeUsageProviderSummary) => (
    (b.totalTokens - a.totalTokens)
    || (b.last30dCostUsd - a.last30dCostUsd)
    || a.provider.localeCompare(b.provider)
  ));
  stats.models.sort((a: AdeUsageModelSummary, b: AdeUsageModelSummary) => (
    (b.totalTokens - a.totalTokens) || (b.costUsd - a.costUsd) || a.model.localeCompare(b.model)
  ));
  stats.daily.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Merge every machine's contribution into an account-scoped payload.
 *
 * `localStats` must already be the machine-scoped result for the same range —
 * it carries the GitHub and ADE-DB context that only this machine can produce.
 * Machines that failed are reported, never thrown: an unreachable laptop costs
 * you its numbers, not the page.
 */
export function mergeAccountUsageStats({
  localStats,
  contributions,
  nowMs,
}: {
  localStats: AdeUsageStats;
  contributions: readonly AccountUsageContribution[];
  nowMs: number;
}): AdeUsageStats {
  const bounds: RangeBounds = { since: localStats.range.since, until: localStats.range.until };
  const { accepted, machines } = resolveContributions(contributions, bounds, nowMs);
  const stats = foldRollupsIntoStats(localStats, accepted, nowMs);
  stats.scope = "account";
  stats.machines = machines;

  const notes = new Set(stats.sourceNotes ?? []);
  const counted = machines.filter((machine) => machine.state !== "failed" && machine.state !== "deduped");
  if (counted.length > 1) {
    notes.add(`Tokens and cost merged across ${counted.length} computers.`);
  }
  const failed = machines.filter((machine) => machine.state === "failed");
  if (failed.length > 0) {
    notes.add(`${failed.length} computer${failed.length === 1 ? "" : "s"} didn't report — not in these totals.`);
  }
  const deduped = machines.filter((machine) => machine.state === "deduped");
  if (deduped.length > 0) {
    notes.add(`${deduped.length} computer${deduped.length === 1 ? "" : "s"} share transcripts with another and are counted once.`);
  }
  if (machines.length > 1) {
    notes.add("Repository and pull request activity is from this computer only.");
  }
  stats.sourceNotes = [...notes];
  return stats;
}
