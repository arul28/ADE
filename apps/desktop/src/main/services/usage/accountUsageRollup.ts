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
 * 2. **Historical rows merge; live quota pools.** Cost, tokens, code and PR
 *    history merge as durable rows. Live quota windows also travel, but only as
 *    an in-memory side channel: provider rate limits are tied to the provider
 *    account, not the machine, so the same login on two machines reports the
 *    same window. The pooled view counts each account once (freshest reading
 *    per account + window label) instead of double-counting a shared limit. The
 *    windows never enter the CRR-replicated rollup store — they change every
 *    poll, and storing them would churn the CRR clock. `poolLiveQuota` is the
 *    one place the pooling rule lives.
 *
 * Chats, shells, commits and PRs travel as per-day counts per project
 * database (`activity`), never as session ids. They merge by database, not by
 * machine — see `mergeAccountActivity`.
 *
 * GitHub metrics are deliberately absent from the rollup. They are repo-scoped,
 * not machine-scoped: three machines with the same repo cloned each report the
 * same pull requests, and summing them would triple the PR count for work that
 * happened once. The account page therefore shows GitHub numbers from the local
 * machine only, and says so in `sourceNotes`.
 */

import type {
  AdeUsageActivityDatabase,
  AdeUsageActivityDay,
  AdeUsageLiveEnvironment,
  AdeUsageMachineContribution,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRollup,
  AdeUsageRollupActivity,
  AdeUsageRollupRow,
  AdeUsageStats,
  CostSnapshot,
  UsageAccount,
  UsageWindow,
} from "../../../shared/types";
import { poolLiveQuota } from "../../../shared/usageLiveQuota";
import { localDayKey, localDayOrdinal } from "./localDay";
import { isSameTranscriptSource } from "./accountUsageSource";
import { addCostSplit, emptyCostSplit, finalizeCostSplit, parseCostSplit } from "../../../shared/usageCostSplit";
import { BRAND } from "../../../shared/brand";

// The pooling rule is shared with the renderer's environment filter, so the
// account-scope merge and the filtered view can never disagree about one number.
export { poolLiveQuota };

/** A rollup older than this is still counted, but flagged so the UI can say it lags. */
export const ACCOUNT_ROLLUP_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Caps on the live-quota side channel, on both the producing and the receiving
 * side. A snapshot holds a handful of windows and accounts; these are the
 * honest maximum past which the payload is broken or hostile and is heading for
 * a peer's memory.
 */
export const MAX_LIVE_QUOTA_WINDOWS = 200;
export const MAX_LIVE_QUOTA_ACCOUNTS = 100;

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
  /**
   * Live quota this machine reported, from the in-memory side channel. Absent
   * for a machine whose ADE predates pooling, or one that has no live readings.
   */
  liveWindows?: UsageWindow[];
  liveAccounts?: UsageAccount[];
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
          const costSplit = finalizeCostSplit(parseCostSplit(tokens.costSplit));
          rows.push({
            date,
            provider,
            model: model || "unknown",
            inputTokens,
            outputTokens,
            cachedTokens,
            totalTokens,
            costUsd,
            calls: toNonNegativeInt(tokens.calls),
            ...(costSplit ? { costSplit } : {}),
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
  // A summary is shown split only when every dollar in it came with one.
  const unsplitProviders = new Set<string>();
  const unsplitModels = new Set<string>();

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
      const rowSplit = parseCostSplit(row.costSplit);
      if (rowSplit) {
        addCostSplit(providerSummary.costSplit ??= emptyCostSplit(), rowSplit);
        addCostSplit(modelSummary.costSplit ??= emptyCostSplit(), rowSplit);
      } else if (inRangeCost > 0) {
        unsplitProviders.add(provider);
        unsplitModels.add(modelKey);
      }

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
    const split = unsplitProviders.has(summary.provider) ? undefined : finalizeCostSplit(summary.costSplit);
    if (split) summary.costSplit = split;
    else delete summary.costSplit;
  }
  for (const summary of stats.models) {
    summary.costUsd = roundCents(summary.costUsd);
    const split = unsplitModels.has(`${summary.provider}\x00${summary.model}`) ? undefined : finalizeCostSplit(summary.costSplit);
    if (split) summary.costSplit = split;
    else delete summary.costSplit;
  }
  if (unsplitProviders.size) {
    stats.sourceNotes = [
      ...(stats.sourceNotes ?? []),
      "The cost split by token type and speed covers only machines that answered live; it is left off a provider that other machines' saved history also feeds.",
    ];
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
 * Remove the counts the account has no total for.
 *
 * Chat and terminal session counts on `localStats` come from one project's
 * database on the machine that answers. When no machine's rollup carries its
 * activity (every machine runs an ADE from before it), that number is one
 * project's, and on ADE Web or a cloud lane computer it is often a fresh
 * project's 0. An unknown count is left out (the UI then shows no session
 * figure) instead of a wrong one.
 */
export function omitUnknownAccountCounts(stats: AdeUsageStats): void {
  delete stats.summary.chatSessions;
  delete stats.summary.terminalSessions;
  delete stats.summary.sessionCountsPartial;
}

// ── Activity: chats, shells, commits and PRs per day ─────────────

/** Bounds on what one machine's activity may hold, on both the producing and the receiving side. */
export const MAX_ACTIVITY_DATABASES = 32;
export const MAX_ACTIVITY_DAYS = 450;
const MAX_ACTIVITY_COUNT = 1_000_000;
const MAX_ACTIVITY_ID_LENGTH = 128;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedActivityId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ACTIVITY_ID_LENGTH ? value : null;
}

function activityCount(value: unknown): number {
  return Math.min(MAX_ACTIVITY_COUNT, toNonNegativeInt(value));
}

function latestDay(entry: AdeUsageActivityDatabase): string {
  let latest = "";
  for (const day of Object.keys(entry.days)) if (day > latest) latest = day;
  return latest;
}

/**
 * Validate and bound a machine's activity, from a peer's payload or the
 * stored meta column.
 *
 * `undefined` means unknown (absent, malformed, or a version this build does
 * not read), which the merge treats as "this machine's share is not known",
 * never as zero. A valid entry with no databases is a real zero. The output
 * is sorted, so equal activity always serializes to the same text and a
 * republish of unchanged counts is not a CRR write.
 */
export function normalizeRollupActivity(raw: unknown): AdeUsageRollupActivity | undefined {
  if (!isPlainRecord(raw) || raw.version !== 1 || !Array.isArray(raw.dbs)) return undefined;
  const dbs: AdeUsageActivityDatabase[] = [];
  for (const entry of raw.dbs) {
    if (!isPlainRecord(entry) || !isPlainRecord(entry.days)) continue;
    const id = boundedActivityId(entry.id);
    if (!id) continue;
    const scope = boundedActivityId(entry.scope) ?? "";
    // Newest first, so a cap drops the far past rather than this week.
    const dayKeys = Object.keys(entry.days)
      .filter((day) => localDayKey(day) === day)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, MAX_ACTIVITY_DAYS)
      .sort();
    const days: Record<string, AdeUsageActivityDay> = {};
    for (const day of dayKeys) {
      const counts = entry.days[day];
      if (!Array.isArray(counts)) continue;
      const tuple: AdeUsageActivityDay = [
        activityCount(counts[0]),
        activityCount(counts[1]),
        activityCount(counts[2]),
        activityCount(counts[3]),
      ];
      if (tuple.some((count) => count > 0)) days[day] = tuple;
    }
    dbs.push({ id, scope, days });
  }
  dbs.sort((a, b) => latestDay(b).localeCompare(latestDay(a)) || a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));
  const kept = dbs.slice(0, MAX_ACTIVITY_DATABASES);
  kept.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));
  return { version: 1, dbs: kept };
}

/** Deterministic text for the meta column. Callers pass normalized activity. */
export function serializeRollupActivity(activity: AdeUsageRollupActivity): string {
  return JSON.stringify(activity);
}

/**
 * This machine's activity after a re-read of the databases attached now.
 *
 * A brain boots projects lazily, so the databases attached at a publish are
 * often a subset of the ones the machine has. An entry from `previous` whose
 * folder was not re-read this time is kept (its sessions still happened);
 * one that was re-read is replaced by folder, not by id, so a database whose
 * id moved (a replica that merged an older project row) cannot be counted
 * once under each name. Days older than `oldestDay` drop off.
 */
export function mergeOwnActivity(
  previous: AdeUsageRollupActivity | undefined | null,
  fresh: readonly AdeUsageActivityDatabase[],
  oldestDay: string | null,
): AdeUsageRollupActivity {
  const byScope = new Map<string, AdeUsageActivityDatabase>();
  for (const entry of previous?.dbs ?? []) byScope.set(entry.scope || `id:${entry.id}`, entry);
  for (const entry of fresh) byScope.set(entry.scope || `id:${entry.id}`, entry);
  const dbs = [...byScope.values()].map((entry) => ({
    ...entry,
    days: Object.fromEntries(Object.entries(entry.days).filter(([day]) => !oldestDay || day >= oldestDay)),
  })).filter((entry) => Object.keys(entry.days).length > 0);
  return normalizeRollupActivity({ version: 1, dbs }) ?? { version: 1, dbs: [] };
}

type ActivityDayTotals = { sessions: number; commits: number; prs: number };
type ActivityGroup = { days: Map<string, ActivityDayTotals>; chats: number; shells: number };

function raiseDay(group: ActivityGroup, day: string, sessions: number, commits: number, prs: number): void {
  const current = group.days.get(day);
  if (!current) {
    group.days.set(day, { sessions, commits, prs });
    return;
  }
  current.sessions = Math.max(current.sessions, sessions);
  current.commits = Math.max(current.commits, commits);
  current.prs = Math.max(current.prs, prs);
}

/**
 * Put the account's chats, shells, commits and PRs on `stats`.
 *
 * Counts are grouped by project database, not by machine. Two machines that
 * hold copies of one synced database report the same sessions under the
 * same database id, so each group takes the larger count per day (and per
 * range total) rather than the sum; separate databases add up. The local
 * machine's `stats` already carry fresh counts for the database the page was
 * read from (`localDatabaseId`), which join that database's group the same
 * way, so the page is never a ledger scan behind for the open project.
 *
 * With no machine reporting activity at all, the counts stay unknown, as
 * `omitUnknownAccountCounts` leaves them. A machine that reports none but
 * used a model in the range marks the totals as a floor
 * (`sessionCountsPartial`). Returns the in-range days that had any count, for
 * `activeDays`, and the labels of the machines left out.
 */
function mergeAccountActivity(
  stats: AdeUsageStats,
  contributions: readonly AccountUsageContribution[],
  bounds: RangeBounds,
  localDatabaseId: string | null,
): { activeDates: string[]; missing: string[] } {
  const withRollup = contributions.filter((entry) => entry.rollup);
  const reporting = withRollup.filter((entry) => entry.rollup?.activity);
  if (reporting.length === 0) {
    omitUnknownAccountCounts(stats);
    return { activeDates: [], missing: [] };
  }
  const groups = new Map<string, ActivityGroup>();
  const groupFor = (id: string): ActivityGroup => {
    let group = groups.get(id);
    if (!group) {
      group = { days: new Map(), chats: 0, shells: 0 };
      groups.set(id, group);
    }
    return group;
  };
  for (const entry of reporting) {
    for (const database of entry.rollup?.activity?.dbs ?? []) {
      const group = groupFor(database.id);
      let chats = 0;
      let shells = 0;
      for (const [day, counts] of Object.entries(database.days)) {
        if (!dateInBounds(day, bounds)) continue;
        chats += counts[0];
        shells += counts[1];
        raiseDay(group, day, counts[0] + counts[1], counts[2], counts[3]);
      }
      group.chats = Math.max(group.chats, chats);
      group.shells = Math.max(group.shells, shells);
    }
  }
  if (localDatabaseId) {
    const group = groupFor(localDatabaseId);
    for (const point of stats.daily) {
      if (!dateInBounds(point.date, bounds)) continue;
      raiseDay(group, point.date, toNonNegativeInt(point.sessions), toNonNegativeInt(point.commits), toNonNegativeInt(point.prs));
    }
    group.chats = Math.max(group.chats, toNonNegativeInt(stats.summary.chatSessions));
    group.shells = Math.max(group.shells, toNonNegativeInt(stats.summary.terminalSessions));
  }

  const byDay = new Map<string, ActivityDayTotals>();
  let chatSessions = 0;
  let terminalSessions = 0;
  for (const group of groups.values()) {
    chatSessions += group.chats;
    terminalSessions += group.shells;
    for (const [day, totals] of group.days) {
      const sum = byDay.get(day) ?? { sessions: 0, commits: 0, prs: 0 };
      sum.sessions += totals.sessions;
      sum.commits += totals.commits;
      sum.prs += totals.prs;
      byDay.set(day, sum);
    }
  }
  for (const point of stats.daily) {
    const totals = byDay.get(point.date);
    point.sessions = totals?.sessions ?? 0;
    point.commits = totals?.commits ?? 0;
    point.prs = totals?.prs ?? 0;
  }
  stats.summary.chatSessions = chatSessions;
  stats.summary.terminalSessions = terminalSessions;

  const missing = withRollup
    .filter((entry) => entry.rollup && !entry.rollup.activity
      && summarizeRollupRange(entry.rollup.rows, bounds).totalTokens > 0)
    .map((entry) => entry.label || entry.machineKey);
  if (missing.length > 0) stats.summary.sessionCountsPartial = true;
  else delete stats.summary.sessionCountsPartial;

  const activeDates = [...byDay]
    .filter(([, totals]) => totals.sessions > 0 || totals.commits > 0 || totals.prs > 0)
    .map(([day]) => day);
  return { activeDates, missing };
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
  localDatabaseId = null,
}: {
  localStats: AdeUsageStats;
  contributions: readonly AccountUsageContribution[];
  nowMs: number;
  /** The project database `localStats` read its chats from (`readActivityDatabaseId`). */
  localDatabaseId?: string | null;
}): AdeUsageStats {
  const bounds: RangeBounds = { since: localStats.range.since, until: localStats.range.until };
  const { accepted, machines } = resolveContributions(contributions, bounds, nowMs);
  const stats = foldRollupsIntoStats(localStats, accepted, nowMs);
  stats.scope = "account";
  stats.machines = machines;
  // Every machine with a rollup, deduped ones too: transcript dedupe says
  // two machines read the same model logs, not the same project database,
  // and the activity merge dedupes by database on its own.
  const activity = mergeAccountActivity(stats, contributions, bounds, localDatabaseId);
  // Active days are a stat about the user, so on the account scope they count
  // a day any machine used a model, not only days this project's database
  // saw. The database's own count can include days the daily series does not
  // carry (a deleted lane's), so it stays the floor.
  //
  // Counted from the dates themselves, not only the chart: a peer's rollup
  // can reach further back than the chart's day skeleton (the `all` preset
  // charts a year, rollups keep more), and those days are still active days.
  const activeDates = new Set(stats.daily
    .filter((point) => point.totalTokens > 0 || point.sessions > 0 || point.commits > 0 || point.prs > 0)
    .map((point) => point.date));
  for (const entry of accepted) {
    if (entry.isLocal || !entry.rollup) continue;
    for (const row of entry.rollup.rows) {
      if (row.totalTokens > 0 && dateInBounds(row.date, bounds)) activeDates.add(row.date);
    }
  }
  for (const day of activity.activeDates) activeDates.add(day);
  stats.summary.activeDays = Math.max(stats.summary.activeDays ?? 0, activeDates.size);

  // Live quota pools across every machine that reported it, local first. Live
  // readings do not depend on the historical rollup being ready, so this reads
  // the raw contributions rather than the accepted set — a fresh machine whose
  // first ledger scan is still running still has live quota to show. A deduped
  // machine is excluded: it shares the winner's transcripts and its live
  // windows are the same login, so including it would count the login twice. A
  // failed machine is listed with no windows so the filter can select it.
  const liveByKey = new Map<string, AccountUsageContribution>();
  for (const contribution of contributions) liveByKey.set(contribution.machineKey, contribution);
  const environments: AdeUsageLiveEnvironment[] = machines
    .filter((machine) => machine.state !== "deduped")
    .map((machine) => {
      const contribution = liveByKey.get(machine.machineKey);
      return {
        machineKey: machine.machineKey,
        label: machine.label,
        platform: machine.platform,
        isLocal: machine.isLocal,
        state: machine.state,
        windows: contribution?.liveWindows ?? [],
        accounts: contribution?.liveAccounts ?? [],
      };
    });
  if (environments.length > 0) stats.liveQuota = { environments };

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
    notes.add("GitHub repository and pull request activity is from this computer only.");
  }
  if (activity.missing.length > 0) {
    notes.add(`Chats, commits and PRs leave out ${activity.missing.length === 1 ? "1 computer that runs" : `${activity.missing.length} computers that run`} an older ${BRAND.NAME}: ${activity.missing.join(", ")}.`);
  }
  stats.sourceNotes = [...notes];
  return stats;
}
