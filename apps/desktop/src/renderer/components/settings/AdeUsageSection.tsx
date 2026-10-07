/**
 * Settings → Usage.
 *
 * One scrolling page. This replaced a two-tab split ("Limits" and "Activity")
 * that divided the screen by where the numbers came from rather than by what
 * you wanted to know, so answering "am I spending a lot and am I about to be
 * cut off" meant visiting both halves and holding them in your head.
 *
 * Reading order is deliberate: the cost you have already incurred, the shape of
 * how you incurred it, then the limits that decide whether you can keep going.
 */
import React from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import type {
  AdeUsageCostBreakdownTotals,
  AdeUsageDailyPoint,
  AdeUsageMachineContribution,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRangePreset,
  AdeUsageScope,
  AdeUsageStats,
} from "../../../shared/types";
import { formatCompact, formatDayShort, formatSpend, formatTokens, relativeTimeCompact } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { ActivityModule, RANGE_OPTIONS } from "../usage/ActivityModule";
import { providerColor } from "../usage/providerColors";
import { ProviderLogo } from "../shared/ProviderLogos";
import {
  UsageChartLegend,
  UsageDailyChart,
  buildDayColumns,
  selectTopSeries,
} from "../usage/UsageDailyChart";
import { UsagePooledLimits } from "../usage/UsagePooledLimits";
import { CostSplitBars } from "../usage/UsageCostSplit";
import { UsageSegmented } from "../usage/UsageSegmented";
import { DeltaTag, UsageDayStrip, UsageSparkline, periodDelta } from "../usage/UsageSparks";
import { UsageWeekCompare, dayMetric } from "../usage/UsageWeekCompare";
import { UsageLimitGauges } from "../usage/UsageLimitGauges";
import { humanizeProvider } from "../usage/usageProviderNames";
import { sumCostSplitsOrNull } from "../../../shared/usageCostSplit";
import { UsageBreakdown } from "./UsageBreakdown";
import { UsageModelDetailDialog } from "./UsageModelDetailDialog";
import { formatUpdatedAge } from "../usage/usageWindowFormat";
import { SettingsColumn } from "./primitives";
import "../usage/usageSurfaces.css";

const SCOPE_STORAGE_KEY = "ade.stats.scope.v1";
const RANGE_STORAGE_KEY = "ade.stats.range.v1";
/*
 * Live quota is shown here as gauges, one per window, with where each window
 * is in its cycle. The top-bar meter answers "how much is left" at a glance;
 * this page answers it with pace and cycle beside it, next to the history
 * that explains it. The account scope shows the pooled, all-machines version.
 */

/** How often the machine list re-reads the clock to age its "2m ago" labels. */
const MACHINE_FRESHNESS_TICK_MS = 15_000;

/** Stable identity so an absent `machines` field does not remount the list. */
const EMPTY_MACHINES: readonly AdeUsageMachineContribution[] = [];

/**
 * Last-rendered stats per scope/preset, so reopening the page paints instantly
 * instead of blanking for the ~50s a cold ledger scan can take.
 *
 * Deliberately in-memory only and deliberately un-invalidated: every read that
 * consults it also fires the real `getAdeStats` call and overwrites the entry
 * with the result, so an entry can only ever be shown *ahead of* fresh data,
 * never instead of it. Nothing here survives a renderer reload, so it cannot
 * carry stale numbers across an app restart — the persisted snapshot in the
 * main process is the only cache that can, and it is version-stamped.
 */
const usageStatsCache = new Map<string, AdeUsageStats>();

function statsCacheKey(scope: string, sourceScope: AdeUsageScope, preset: AdeUsageRangePreset): string {
  return `${scope}:${sourceScope}:${preset}`;
}

function cacheScopeFromProject(project: { rootPath?: string | null } | null | undefined): string {
  return project?.rootPath?.trim() || "browser-preview";
}

const SCOPE_VALUES: readonly AdeUsageScope[] = ["account", "machine", "project"];

function readScope(): AdeUsageScope {
  if (typeof localStorage === "undefined") return "project";
  const value = localStorage.getItem(SCOPE_STORAGE_KEY);
  return SCOPE_VALUES.includes(value as AdeUsageScope) ? (value as AdeUsageScope) : "project";
}

function persistScope(scope: AdeUsageScope): void {
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // best-effort
  }
}

function readPreset(): AdeUsageRangePreset {
  if (typeof localStorage === "undefined") return "all";
  const value = localStorage.getItem(RANGE_STORAGE_KEY);
  return RANGE_OPTIONS.some((option) => option.preset === value)
    ? (value as AdeUsageRangePreset)
    : "all";
}

function persistPreset(preset: AdeUsageRangePreset): void {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, preset);
  } catch {
    // best-effort
  }
}

function formatWhole(value: number): string {
  return Math.max(0, Math.floor(value || 0)).toLocaleString();
}

function estimationNote(kind: AdeUsageProviderSummary["estimation"]): string | null {
  switch (kind) {
    case "chars":
      return "counted from text length, not reported token counts";
    case "distribution":
      return "daily split estimated across the range";
    case "mixed":
      return "partly estimated";
    default:
      return null;
  }
}

/**
 * Which rate card produced the figure above it.
 *
 * The cost is this page's headline and the rates behind it are not the user's
 * to guess: a machine pricing from the maintained public list and one pricing
 * from ADE's built-in fallback can report different numbers for identical
 * usage, and only this line says which one you are looking at.
 */
function describeRatesSource(
  providers: AdeUsageProviderSummary[],
  pricingUpdatedAt?: string | null,
): string | null {
  const sources = new Set(
    providers.flatMap((provider) => (provider.pricingSource ? [provider.pricingSource] : [])),
  );
  if (sources.size === 0) return null;
  const listAge = pricingUpdatedAt ? formatUpdatedAge(pricingUpdatedAt, Date.now()) : null;
  const fromList = listAge ? `priced from the public rate list, ${listAge}` : "priced from the public rate list";
  if (sources.has("mixed") || sources.size > 1) {
    return `Rates: ${fromList}, except a few models only ADE's built-in list knows.`;
  }
  return sources.has("list")
    ? `Rates: ${fromList}.`
    : "Rates: priced from ADE's built-in fallback list — the public rate list couldn't be reached.";
}

const MS_PER_DAY = 86_400_000;

/**
 * The contiguous run of days at the end of the series.
 *
 * `makeDailySkeleton` emits a gap-free window (at most 365 days), but on the
 * `all` preset `mergeSnapshotDailyTokens` appends a point for every date the
 * ledger scan saw — reaching back as far as 3650 days — which then sorts to the
 * front. The chart spaces columns by index, so a sparse 18-month tail would be
 * drawn at the same pitch as the dense recent window and read as if those
 * months were equally busy. Cutting at the first gap keeps the axis honest.
 */
function contiguousTail(points: readonly AdeUsageDailyPoint[]): readonly AdeUsageDailyPoint[] {
  if (points.length < 2) return points;
  let start = points.length - 1;
  for (let index = points.length - 1; index > 0; index -= 1) {
    const current = Date.parse(`${points[index]!.date}T00:00:00Z`);
    const previous = Date.parse(`${points[index - 1]!.date}T00:00:00Z`);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) break;
    if (current - previous !== MS_PER_DAY) break;
    start = index - 1;
  }
  return start === 0 ? points : points.slice(start);
}

function platformGlyph(platform: string | null | undefined): string {
  const normalized = (platform ?? "").toLowerCase();
  // Not an SF Symbols codepoint: that font is Apple-only, and this string is
  // also read on Windows and Linux desktops and travels to the mobile and web
  // clients, where a private-use glyph renders as tofu.
  if (normalized.includes("darwin") || normalized.includes("mac")) return "🍎";
  if (normalized.includes("win")) return "⊞";
  if (normalized.includes("linux")) return "🐧";
  return "●";
}

/**
 * `range.since` / `range.until` are full ISO timestamps, not bare `YYYY-MM-DD`
 * days — `resolveAdeUsageRange` builds them from `startOfLocalDayOffsetIso` and
 * `toISOString()`. Appending a time to them yields `...ZT00:00:00`, which parses
 * as Invalid Date, so they are parsed directly.
 */
function formatRangeLabel(stats: AdeUsageStats | null): string {
  if (!stats) return "";
  const { since, until } = stats.range;
  const pretty = (iso: string): string | null => {
    const parsed = new Date(iso);
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : null;
  };
  const end = pretty(until);
  if (!end) return "";
  const start = since ? pretty(since) : null;
  return start ? `${start} – ${end}` : `Through ${end}`;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * Where a metric's number actually came from.
 *
 * The strip used to put provider-ledger tokens, ADE's own git bookkeeping and
 * GitHub's pull-request counts side by side with nothing to tell them apart, so
 * two adjacent tiles could disagree about the same week and both be right.
 * `shared/types/usage.ts` keeps the two activity sources deliberately unmerged
 * (`localActivity` / `githubActivity`); this is the label that makes that split
 * visible instead of leaving the reader to guess.
 */
type MetricSource = "Providers" | "GitHub" | "Local git";

/**
 * One cell of the stat strip: mono eyebrow, a big tight number, one muted mono
 * line of context. The source label stays beside the eyebrow so provider-ledger
 * tokens and GitHub's pull-request counts never read as the same kind of number.
 */
function Metric({
  label,
  value,
  detail,
  source,
  tag,
  size = "lg",
  valueTitle,
  detailTitle,
  trend,
}: {
  /** A tiny trend under the number (sparkline or day strip). */
  trend?: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  source?: MetricSource;
  tag?: { text: string; tone?: "ok" | "warn" | "crit"; title?: string } | null;
  size?: "lg" | "sm";
  valueTitle?: string;
  detailTitle?: string;
}) {
  return (
    <div className="usage-stat">
      <span className="usage-stat-head">
        <span className="kit-eyebrow">{label}</span>
        {source ? <span className="usage-stat-source">{source}</span> : null}
      </span>
      <span className="usage-stat-value">
        <span className={size === "lg" ? "kit-stat" : "usage-stat-num"} title={valueTitle}>{value}</span>
        {tag ? <span className="kit-tag" data-tone={tag.tone} title={tag.title}>{tag.text}</span> : null}
      </span>
      {trend ? <span className="usage-stat-trend">{trend}</span> : null}
      {detail ? (
        <span className="usage-stat-detail" title={detailTitle} style={detailTitle ? { cursor: "help" } : undefined}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The code-movement tile, resolved against whichever source actually measured
 * anything.
 *
 * It used to read `summary.insertions + summary.deletions`, which is ADE's own
 * `session_deltas` table and nothing else. On a machine whose deltas stopped
 * being written — 15 rows, all zero, on a repo with 33 commits that week — the
 * tile was a permanent 0 sitting next to live GitHub numbers. `prAdditions` /
 * `prDeletions` were already computed and never rendered anywhere, so the tile
 * now prefers them and says so; local deltas remain the fallback for a project
 * with no GitHub data; and when neither source has anything it shows an em dash
 * rather than a confident zero.
 */
function codeMovementMetric(stats: AdeUsageStats | null): {
  value: string;
  detail: string;
  source?: MetricSource;
} {
  const summary = stats?.summary;
  if (!summary) return { value: "—", detail: "" };

  const githubAdditions = stats?.githubActivity?.prAdditions ?? summary.prAdditions;
  const githubDeletions = stats?.githubActivity?.prDeletions ?? summary.prDeletions;
  if (githubAdditions + githubDeletions > 0) {
    return {
      value: formatWhole(githubAdditions + githubDeletions),
      detail: `+${formatWhole(githubAdditions)} / −${formatWhole(githubDeletions)} in pull requests`,
      source: "GitHub",
    };
  }

  const insertions = stats?.localActivity?.insertions ?? summary.insertions;
  const deletions = stats?.localActivity?.deletions ?? summary.deletions;
  if (insertions + deletions > 0) {
    const filesChanged = stats?.localActivity?.filesChanged ?? summary.filesChanged;
    return {
      value: formatWhole(insertions + deletions),
      detail: `+${formatWhole(insertions)} / −${formatWhole(deletions)} across ${formatWhole(filesChanged)} files`,
      source: "Local git",
    };
  }

  return { value: "—", detail: "no code changes recorded in this range" };
}

/**
 * The cost cell's footnote and its explanation.
 *
 * The asterisk is a real explanation, not decoration: unlike tools that read
 * exact token counts out of provider transcripts, some of our ledgers estimate
 * tokens from character counts, so this figure has two independent sources of
 * softness and the reader deserves to know which apply.
 */
function costFootnote(providers: AdeUsageProviderSummary[], pricingUpdatedAt?: string | null): { text: string; title: string } {
  const estimated = providers
    .map((provider) => {
      const note = estimationNote(provider.estimation);
      return note ? `${humanizeProvider(provider.provider)}: ${note}` : null;
    })
    .filter((entry): entry is string => entry !== null);
  const ratesNote = describeRatesSource(providers, pricingUpdatedAt);
  const text =
    estimated.length === 0
      ? "* if billed at full API rate"
      : `* if billed at full API rate — ${estimated.length === 1 ? "one provider is" : `${estimated.length} providers are`} estimated`;
  const title = [
    estimated.length > 0
      ? `Not money spent — subscriptions bill separately.\n\n${estimated.join("\n")}`
      : "Not money spent — subscriptions bill separately. Token counts are provider-reported.",
    ratesNote,
  ].filter(Boolean).join("\n\n");
  return { text, title };
}

/** What the range's cost went to, by token type and speed, plus ADE's own billing. */
function CostComposition({
  providers,
  billing,
  theme,
  facts,
}: {
  facts: Array<{ label: string; value: string; detail?: string }>;
  providers: AdeUsageProviderSummary[];
  /** ADE chats' billed dollars and plan value, from the per-turn ledger. */
  billing: AdeUsageCostBreakdownTotals | null;
  theme: "dark" | "light";
}) {
  // The page total's split is the providers' splits added up, shown only when
  // every provider with a cost sent one: a partial split would mislead.
  const split = sumCostSplitsOrNull(providers.filter((provider) => provider.rangeCostUsd > 0).map((provider) => provider.costSplit));
  return (
    <div className="flex flex-col gap-4">
      {facts.length > 0 ? (
        <>
          <div className="usage-facts">
            {facts.map((fact) => (
              <div key={fact.label} className="usage-fact">
                <span className="kit-eyebrow">{fact.label}</span>
                <span className="usage-fact-value">{fact.value}</span>
                {fact.detail ? <span className="usage-stat-detail">{fact.detail}</span> : null}
              </div>
            ))}
          </div>
          <hr className="kit-rule" />
        </>
      ) : null}
      <CostSplitBars split={split} theme={theme} />
      {!split ? <span className="usage-footnote">No per-type cost split reported for this range.</span> : null}
      {billing && billing.turns > 0 ? (
        <>
          <hr className="kit-rule" />
          <div
            className="flex flex-col gap-2"
            title="From ADE's per-turn ledger: chats ADE ran on this machine. Billed is what API keys and routed accounts were charged; plan value is what subscription turns would have cost at list prices."
          >
            <span className="kit-eyebrow">ADE chats</span>
            <div className="usage-split-legend">
              <span className="usage-split-legend-item">Billed to API keys<b>{formatSpend(billing.billedUsd)}</b></span>
              <span className="usage-split-legend-item">Plan value<b>{formatSpend(billing.planValueUsd)}</b></span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

const DONUT_SIZE = 148;
const DONUT_STROKE = 14;

/**
 * Per-provider share of the range's cost: a donut with the total in its centre
 * and a ranked legend beside it — logo, name, thin share bar, mono value.
 */
function ProviderCostSplit({
  providers,
  theme,
  totalCostUsd,
  loading,
  highlightedMembers,
  onHighlight,
}: {
  providers: AdeUsageProviderSummary[];
  theme: "dark" | "light";
  totalCostUsd: number;
  loading: boolean;
  /**
   * The provider ids currently lit, or `null` for "nothing is". A set rather
   * than a single id because hovering the chart's merged "Other" band lights
   * every provider folded into it.
   */
  highlightedMembers: ReadonlySet<string> | null;
  onHighlight: (provider: string | null) => void;
}) {
  const total = providers.reduce((sum, provider) => sum + Math.max(0, provider.rangeCostUsd), 0);
  const ranked = [...providers]
    .filter((provider) => provider.totalTokens > 0 || provider.rangeCostUsd > 0)
    .sort((a, b) => b.rangeCostUsd - a.rangeCostUsd);

  const radius = (DONUT_SIZE - DONUT_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = ranked.filter((provider) => provider.rangeCostUsd > 0).length > 1 ? 2 : 0;
  let offset = 0;

  return (
    <div className="usage-donut-layout">
      <div className="usage-donut">
        <svg width={DONUT_SIZE} height={DONUT_SIZE} viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`} aria-hidden>
          <circle
            cx={DONUT_SIZE / 2}
            cy={DONUT_SIZE / 2}
            r={radius}
            fill="none"
            stroke="var(--kit-track)"
            strokeWidth={DONUT_STROKE}
          />
          {total > 0
            ? ranked.map((provider) => {
                const share = Math.max(0, provider.rangeCostUsd) / total;
                const length = Math.max(0, share * circumference - gap);
                const dash = `${length} ${circumference - length}`;
                const segment = (
                  <circle
                    key={provider.provider}
                    cx={DONUT_SIZE / 2}
                    cy={DONUT_SIZE / 2}
                    r={radius}
                    fill="none"
                    stroke={providerColor(provider.provider, theme)}
                    strokeWidth={DONUT_STROKE}
                    strokeDasharray={dash}
                    strokeDashoffset={-offset}
                    style={{
                      opacity: highlightedMembers && !highlightedMembers.has(provider.provider) ? 0.25 : 1,
                      transition: "opacity 140ms ease",
                    }}
                    onMouseEnter={() => onHighlight(provider.provider)}
                    onMouseLeave={() => onHighlight(null)}
                  />
                );
                offset += share * circumference;
                return segment;
              })
            : null}
        </svg>
        <div className="usage-donut-center">
          <span className="kit-eyebrow">Total</span>
          <span className="usage-donut-total">{loading ? "—" : formatSpend(totalCostUsd)}</span>
        </div>
      </div>
      {ranked.length === 0 ? (
        <span className="usage-footnote">No provider spend in this range.</span>
      ) : (
        // ADE tracks nine providers. The list scrolls inside its own bounds
        // instead of growing past the donut; the four or five a typical machine
        // reports never scroll at all.
        <ul className="usage-rank">
          {ranked.map((provider) => {
            const share = total > 0 ? provider.rangeCostUsd / total : 0;
            const color = providerColor(provider.provider, theme);
            const focused = highlightedMembers?.has(provider.provider) ?? false;
            const dimmed = highlightedMembers !== null && !focused;
            return (
              <li
                key={provider.provider}
                className="usage-rank-row"
                data-dimmed={dimmed ? "true" : undefined}
                // The hovered provider tints in its own brand colour, so the
                // row, its slice and its band in the chart read as one thing.
                style={focused ? { background: `color-mix(in srgb, ${color} 10%, transparent)` } : undefined}
                onMouseEnter={() => onHighlight(provider.provider)}
                onMouseLeave={() => onHighlight(null)}
                title={`${formatTokens(provider.totalTokens)} tokens`}
              >
                <span aria-hidden className="usage-rank-mark" style={{ boxShadow: `0 0 0 1.5px ${color}` }}>
                  <ProviderLogo family={provider.provider} size={12} />
                </span>
                <span className="usage-rank-name">
                  {humanizeProvider(provider.provider)}
                  <span className="usage-rank-share">{`${Math.round(share * 100)}%`}</span>
                </span>
                <span className="usage-rank-value">{formatSpend(provider.rangeCostUsd)}</span>
                <span aria-hidden className="usage-rank-bar">
                  <span style={{ width: `${(share * 100).toFixed(1)}%`, background: color }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * What to say when the chart cannot draw cost.
 *
 * The old string, "Daily cost needs a newer host", named the wrong cause. The
 * chart falls back to tokens whenever no day in the range carries a
 * per-provider split — and the commonest way that happens on a perfectly
 * current machine is the default "This project" scope: `buildCostSnapshots`
 * drops every ledger that cannot attribute a row to a project root (Cursor,
 * Droid, Copilot, Gemini, OpenCode…), and the days that remain get their token
 * totals gap-filled from ADE's own database, which carries no provider or cost
 * attribution. So the reader is told what is actually true, and — where there
 * is one — given the move that fixes it.
 */
function ChartCostUnavailable({
  scope,
  onShowMachine,
}: {
  scope: AdeUsageScope;
  onShowMachine: () => void;
}) {
  if (scope === "project") {
    return (
      <span className="usage-card-sub flex items-center gap-2">
        Cost isn&apos;t tracked per project
        <button type="button" onClick={onShowMachine} className="kit-card-head-action" style={{ marginLeft: 0, marginRight: 0 }}>
          Show this machine
        </button>
      </span>
    );
  }
  return (
    <span
      className="usage-card-sub"
      title="Your providers reported day-by-day tokens for this range but no day-by-day cost."
    >
      No cost by day in this range
    </span>
  );
}

/**
 * Contributing machines with per-machine freshness.
 *
 * A merged total silently under-reports when a machine has not checked in, and
 * that failure looks exactly like a genuine drop in usage. Listing who reported
 * and when is what keeps the total honest.
 */
function MachineList({ machines }: { machines: readonly AdeUsageMachineContribution[] }) {
  // The clock lives here, not on the page, so ageing one relative timestamp
  // re-renders only these rows — never the 365-column chart above them.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), MACHINE_FRESHNESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  if (machines.length === 0) return null;
  return (
    <dl className="m-0 flex flex-col">
      {machines.map((machine) => (
        <div key={machine.machineKey} className="kit-row" style={{ justifyContent: "space-between" }}>
          <dt className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="text-muted-fg">
              {platformGlyph(machine.platform)}
            </span>
            <span className="truncate">{machine.label.trim() || machine.machineKey}</span>
            {machine.state === "deduped" && machine.dedupedAgainstMachineKey ? (
              <span className="usage-card-sub truncate">
                counted once with {machine.dedupedAgainstMachineKey}
              </span>
            ) : null}
          </dt>
          {/* The merge writes a plain-language reason for failed and stale
              machines; prefer it over a generic label. */}
          <dd className="usage-stat-detail m-0">
            {machine.state === "failed"
              ? machine.message?.trim() || "did not report"
              : formatUpdatedAge(machine.lastReportedAt, nowMs)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function AdeUsageSection() {
  const theme = useAppStore((state) => state.theme);
  const [preset, setPreset] = React.useState<AdeUsageRangePreset>(() => readPreset());
  const [scope, setScope] = React.useState<AdeUsageScope>(() => readScope());
  const [cacheScope, setCacheScope] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<AdeUsageStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [metric, setMetric] = React.useState<"cost" | "tokens">("cost");
  const [highlighted, setHighlighted] = React.useState<string | null>(null);
  const [detailModel, setDetailModel] = React.useState<AdeUsageModelSummary | null>(null);
  const [billing, setBilling] = React.useState<AdeUsageCostBreakdownTotals | null>(null);
  const loadSeqRef = React.useRef(0);

  const loadStats = React.useCallback(
    async (nextPreset: AdeUsageRangePreset, sourceScope: AdeUsageScope, scopeKey: string, force = false) => {
      const loadSeq = loadSeqRef.current + 1;
      loadSeqRef.current = loadSeq;
      const key = statsCacheKey(scopeKey, sourceScope, nextPreset);
      const cached = usageStatsCache.get(key);
      if (cached) {
        setStats(cached);
        setLoading(false);
      } else {
        setStats(null);
        setLoading(true);
      }

      try {
        setError(null);
        if (force) {
          setRefreshing(true);
          await window.ade?.usage?.refreshHistory?.();
        }
        // `force` must reach the read itself, not just `refreshHistory()`.
        // Without it the cross-machine fan-out is indistinguishable from the
        // page's own mount read and gets suppressed by the 30s floor — which
        // the mount read always just tripped, so Refresh would never actually
        // re-poll the other machines.
        const result = await window.ade?.usage?.getAdeStats?.({
          preset: nextPreset,
          scope: sourceScope,
          ...(force ? { force: true } : {}),
        });
        if (!result) throw new Error("Stats are unavailable.");
        if (loadSeqRef.current === loadSeq) {
          usageStatsCache.set(key, result);
          setStats(result);
        }
      } catch (err) {
        if (loadSeqRef.current === loadSeq) {
          // A refresh that fails must never cost the user the numbers they were
          // already reading. A full ledger scan can outrun any budget in front
          // of it, and the old code answered that by deleting the cache and
          // rendering the raw rejection — so a slow machine's Refresh blanked
          // the page and printed an internal IPC timeout at the user.
          console.warn("usage.stats_load_failed", err);
          if (cached) {
            setStats(cached);
            // Even a background load has to say something when it fails. The
            // cache has no TTL, so staying silent here left a permanently
            // broken backend rendering a fully-populated page — complete with
            // a freshness badge read off the stale object — that is
            // indistinguishable from a healthy one. Quiet, not alarming, and
            // never at the cost of the numbers already on screen.
            setError(
              force
                ? "Couldn't refresh. Showing the last numbers."
                : "Couldn't check for new usage. Showing the last numbers.",
            );
          } else {
            usageStatsCache.delete(key);
            setStats(null);
            setError("Couldn't load usage. Try again.");
          }
        }
      } finally {
        if (loadSeqRef.current === loadSeq) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  React.useEffect(() => {
    let mounted = true;
    const applyProject = (project: { rootPath?: string | null } | null) => {
      if (!mounted) return;
      loadSeqRef.current += 1;
      setCacheScope(cacheScopeFromProject(project));
      setStats(null);
      setLoading(true);
      setError(null);
    };

    if (!window.ade?.app?.getProject) {
      applyProject(null);
      return () => {
        mounted = false;
      };
    }

    void window.ade.app.getProject().then(applyProject).catch(() => applyProject(null));
    const unsubscribe = window.ade.app.onProjectChanged?.(applyProject);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  // The page is now a single scroll, so stats load whenever it is mounted —
  // there is no longer an "activity tab" to gate the fetch behind.
  React.useEffect(() => {
    if (!cacheScope) return;
    void loadStats(preset, scope, cacheScope, false);
  }, [cacheScope, loadStats, preset, scope]);

  React.useEffect(() => {
    if (!cacheScope) return;
    const unsubscribe = window.ade?.usage?.onUpdate?.(() => {
      void loadStats(preset, scope, cacheScope, false);
    });
    return () => unsubscribe?.();
  }, [cacheScope, loadStats, preset, scope]);

  // Billed vs plan value for ADE's own chats rides the per-turn ledger, read
  // per range whenever the stats reload. A host without the action shows none.
  React.useEffect(() => {
    if (!stats || typeof window.ade?.usage?.getCostBreakdown !== "function") {
      setBilling(null);
      return;
    }
    let cancelled = false;
    // "This project" reads its own chats (grouped by lane); the machine and
    // account views read every ADE chat on the machine (grouped by account).
    void window.ade.usage.getCostBreakdown({ by: scope === "project" ? "lane" : "account", preset, limit: 1 })
      .then((result) => {
        if (!cancelled) setBilling(result?.available ? result.totals : null);
      })
      .catch(() => {
        if (!cancelled) setBilling(null);
      });
    return () => {
      cancelled = true;
    };
  }, [preset, scope, stats]);

  // C and T switch the metric, the way the segmented control does, unless a
  // field or a dialog has the keyboard.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || detailModel) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      const key = event.key.toLowerCase();
      if (key === "c") setMetric("cost");
      else if (key === "t") setMetric("tokens");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailModel]);

  const knownModels = React.useMemo(
    () => Array.from(new Set((stats?.models ?? []).map((model) => model.model))).sort(),
    [stats?.models],
  );

  const changeScope = React.useCallback((next: AdeUsageScope) => {
    setScope(next);
    persistScope(next);
  }, []);

  const changePreset = React.useCallback((next: AdeUsageRangePreset) => {
    setPreset(next);
    persistPreset(next);
  }, []);

  const summary = stats?.summary;
  // The x axis comes from the days the main process emitted, cut at the first
  // gap. Re-deriving it from `range.since`→`until` (as an earlier version did)
  // both stretched the axis past main's per-preset day budget and mis-parsed
  // the ISO bounds; taking the emitted days wholesale instead let the `all`
  // preset's sparse multi-year tail through. The contiguous tail is the window
  // that is actually gap-free, which is what the chart's index-spaced columns
  // assume.
  const daily = React.useMemo(() => contiguousTail(stats?.daily ?? []), [stats?.daily]);
  const days = React.useMemo(() => daily.map((point) => point.date), [daily]);

  // Chart series are derived here as well as inside the chart so the legend can
  // key the same bands. Both calls are memoized on the same inputs, so the work
  // happens once per data change rather than once per render.
  const { chartSeries, chartIsCombined } = React.useMemo(() => {
    if (days.length === 0) return { chartSeries: [], chartIsCombined: false };
    const columns = buildDayColumns(days, daily, metric);
    return {
      chartSeries: selectTopSeries(columns.columns, columns.providers),
      chartIsCombined: columns.combined,
    };
  }, [daily, days, metric]);

  // One highlight travels across two surfaces that do not share an id space:
  // the cost split speaks provider ids, while the chart draws at most four of
  // them plus a merged "Other". Resolving the hovered id to the chart series
  // that owns it — and then back to that series' members — is what makes
  // hovering "Other" light every provider inside it, and hovering a provider
  // the chart does not draw light only its own row instead of dimming the
  // entire page.
  const highlightedMembers = React.useMemo(() => {
    if (!highlighted) return null;
    const owner = chartSeries.find(
      (entry) => entry.id === highlighted || entry.members.includes(highlighted),
    );
    return new Set(owner ? owner.members : [highlighted]);
  }, [chartSeries, highlighted]);

  // No day in the range carries a per-provider split, so there is no daily cost
  // to plot — only daily tokens. Plotting "cost" would draw a flat zero line
  // under a non-zero hero, which reads as a bug rather than as missing data, so
  // the toggle drops to tokens and `ChartCostUnavailable` says why.
  const costChartUnavailable = chartIsCombined;
  const effectiveMetric = costChartUnavailable ? "tokens" : metric;

  const machines = stats?.machines ?? EMPTY_MACHINES;
  const sourceNotes = React.useMemo(() => {
    const notes = (stats?.sourceNotes ?? []).map((note) => note.trim()).filter(Boolean);

    // Some ledger rows are aggregates carrying totals but no usable timestamp.
    // They count toward the range total but cannot land on a day, so on the
    // "all" preset the chart can sum to less than the hero above it. Placing
    // them on the chart would mean inventing a date — either a fake spike on one
    // day or a smooth curve over data nobody measured — so the drift stays and
    // is disclosed instead. Derived here because it is a statement about two
    // numbers this page renders, not a property of the ledger.
    const rangeCost = stats?.summary.observedProviderCostRangeUsd ?? 0;
    // Two conditions are deliberately excluded, because in both the gap has a
    // different cause and calling it "no date" would be a lie:
    //  - `chartIsCombined`: the host reports no per-provider daily split, so
    //    charted cost is zero and this would claim the whole total is undated —
    //    a case the chart already explains in its own words three lines up.
    //  - `account` scope: remote rows outside the local day skeleton are
    //    dropped from `daily` but still counted in the range total. Those rows
    //    have perfectly good dates; they are simply off the end of the window.
    if (preset === "all" && scope !== "account" && rangeCost > 0 && !chartIsCombined) {
      const chartedCost = daily.reduce(
        (sum, point) =>
          sum +
          Object.values(point.byProvider ?? {}).reduce(
            (inner, entry) => inner + (entry.costUsd || 0),
            0,
          ),
        0,
      );
      const undated = rangeCost - chartedCost;
      if (undated > 0.01 && undated / rangeCost > 0.01) {
        notes.push(
          `${formatSpend(undated)} of this total comes from records with no date and isn't on the daily chart.`,
        );
      }
    }
    return notes;
  }, [
    chartIsCombined,
    daily,
    preset,
    scope,
    stats?.sourceNotes,
    stats?.summary.observedProviderCostRangeUsd,
  ]);
  const isEmpty = !loading && !error && (summary?.totalTokens ?? 0) === 0 && daily.length === 0;

  // Both PR figures come from GitHub, so they are read from the labeled
  // `githubActivity` group when the host publishes it rather than from the
  // legacy flat summary fields that sit beside ADE-DB numbers.
  const codeMovement = React.useMemo(() => codeMovementMetric(stats), [stats]);
  const prsTracked = stats?.githubActivity?.prsTracked ?? summary?.prsTracked ?? 0;
  const prsMerged = stats?.githubActivity?.prsMerged ?? summary?.prsMerged ?? 0;

  const updatedLabel = stats
    ? relativeTimeCompact(stats.freshness?.providerUpdatedAt ?? stats.generatedAt)
    : null;

  const chartActions = costChartUnavailable ? (
    <ChartCostUnavailable scope={scope} onShowMachine={() => changeScope("machine")} />
  ) : (
    <UsageSegmented
      ariaLabel="Chart metric"
      options={[
        { value: "cost", label: "Cost", title: "Cost (C)" },
        { value: "tokens", label: "Tokens", title: "Tokens (T)" },
      ]}
      value={metric}
      onChange={setMetric}
    />
  );

  const noStats = loading || !stats;
  const footnote = costFootnote(stats?.providers ?? [], stats?.pricingUpdatedAt);
  const sessions = (summary?.chatSessions ?? 0) + (summary?.terminalSessions ?? 0);
  // Some ledgers count cache reads inside input, others beside it (Anthropic
  // reports them separately, so cached can exceed "input" many times over).
  // When cached outgrows input it cannot be a subset, so it joins the base.
  const cachedShare = (() => {
    if (!summary) return null;
    const cached = summary.observedProviderCachedTokens;
    const input = summary.observedProviderInputTokens;
    const base = cached > input ? input + cached : input;
    return base > 0 ? Math.min(100, Math.round((cached / base) * 100)) : null;
  })();
  const streak = summary?.currentStreakDays ?? 0;
  const rangeDays = daily.length;

  // The last two weeks of the plotted days, for the strip's sparklines and
  // their week-over-week deltas.
  const recent = React.useMemo(() => daily.slice(-14), [daily]);
  const trendTokens = React.useMemo(() => recent.map((point) => point.totalTokens || 0), [recent]);
  const trendCost = React.useMemo(() => recent.map((point) => dayMetric(point, "cost")), [recent]);
  const trendSessions = React.useMemo(() => recent.map((point) => point.sessions || 0), [recent]);
  const trendActive = React.useMemo(
    () => recent.map((point) => (point.totalTokens || 0) > 0 || (point.sessions || 0) > 0),
    [recent],
  );
  const trendTitle = "Last 7 days against the 7 before";

  // Three quick reads of the same spend: the typical day, the worst day, and
  // what a million tokens cost on average. Derived from the plotted days so
  // they agree with the chart above them.
  const costFacts = React.useMemo(() => {
    if (!summary || daily.length === 0) return [];
    const dayCost = (point: AdeUsageDailyPoint) =>
      Object.values(point.byProvider ?? {}).reduce((sum, entry) => sum + (entry.costUsd || 0), 0);
    const active = daily.filter((point) => point.totalTokens > 0);
    const facts: Array<{ label: string; value: string; detail?: string }> = [];
    const charted = daily.reduce((sum, point) => sum + dayCost(point), 0);
    if (charted > 0 && active.length > 0) {
      facts.push({ label: "Avg / day", value: formatSpend(charted / active.length), detail: `over ${active.length} active days` });
      const peak = daily.reduce((best, point) => (dayCost(point) > dayCost(best) ? point : best), daily[0]!);
      facts.push({ label: "Peak", value: formatSpend(dayCost(peak)), detail: formatDayShort(peak.date) });
    }
    if (summary.totalTokens > 0 && summary.observedProviderCostRangeUsd > 0) {
      facts.push({
        label: "Per 1M",
        value: formatSpend(summary.observedProviderCostRangeUsd / (summary.totalTokens / 1_000_000)),
        detail: "tokens, blended",
      });
    }
    return facts;
  }, [daily, summary]);

  const breakdown = (
    <section className="kit-card">
      <div className="kit-card-head">
        <span>Breakdown</span>
        <span className="usage-card-sub">Select a model for its detail and price</span>
      </div>
      <div className="kit-card-body">
        <UsageBreakdown
          models={stats?.models ?? []}
          preset={preset}
          scope={scope}
          metric={effectiveMetric}
          reloadKey={stats}
          onOpenModel={setDetailModel}
        />
      </div>
    </section>
  );

  return (
    // `#ade-usage` is the anchor the manifest, ⌘K and the header usage control
    // all link to, so the page root carries it.
    <SettingsColumn wide>
      <div id="ade-usage" data-settings-anchor="ade-usage" className="usage-page">
        {/* What the Settings shell cannot know — which range is on screen and
            how old the reading is — sits with the controls that change it. */}
        <header className="usage-toolbar">
          <div className="usage-toolbar-meta">
            <span className="kit-eyebrow">
              {scope === "account" ? "All machines" : scope === "machine" ? "This machine" : "This project"}
            </span>
            <p className="usage-toolbar-range">
              {formatRangeLabel(stats)}
              {updatedLabel ? (updatedLabel === "now" ? " · updated just now" : ` · updated ${updatedLabel} ago`) : ""}
            </p>
          </div>
          <div className="usage-toolbar-controls">
            <UsageSegmented
              ariaLabel="Usage scope"
              labelCase="sentence"
              options={[
                { value: "account", label: "All machines" },
                { value: "machine", label: "This machine" },
                { value: "project", label: "This project" },
              ]}
              value={scope}
              onChange={changeScope}
            />
            <UsageSegmented
              ariaLabel="Date range"
              options={RANGE_OPTIONS.map((option) => ({ value: option.preset, label: option.label }))}
              value={preset}
              onChange={changePreset}
            />
            <button
              type="button"
              onClick={() => cacheScope && loadStats(preset, scope, cacheScope, true)}
              disabled={refreshing || !cacheScope}
              aria-label="Refresh usage"
              title="Refresh"
              className="kit-icon-btn"
            >
              <ArrowClockwise size={13} className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined} />
            </button>
          </div>
        </header>

        {error ? <div className="usage-note">{error}</div> : null}

        {isEmpty ? (
          <section className="kit-card usage-empty">
            <span className="usage-card-title">Nothing here yet</span>
            <span className="usage-card-sub" style={{ maxWidth: "46ch" }}>
              Your first Claude or Codex turn shows up within a minute.
            </span>
          </section>
        ) : (
          <>
            {/* The headline numbers: what it cost, how much moved, how often. */}
            <section className="kit-card" aria-label="Totals">
              <div className="usage-stats">
                <Metric
                  label="Estimated cost"
                  // `!stats`, not `loading && !stats`: a failed load with
                  // nothing cached clears `loading` while `stats` stays null.
                  // No data is not zero.
                  value={noStats ? "—" : `${formatSpend(summary?.observedProviderCostRangeUsd ?? 0)}*`}
                  detail={footnote.text}
                  detailTitle={footnote.title}
                  trend={trendCost.some((value) => value > 0) ? (
                    <>
                      <UsageSparkline values={trendCost} label="Daily cost, last 14 days" color="var(--color-accent)" />
                      <DeltaTag delta={periodDelta(trendCost)} title={trendTitle} />
                    </>
                  ) : null}
                />
                <Metric
                  label="Tokens"
                  source="Providers"
                  value={summary ? formatTokens(summary.totalTokens) : "—"}
                  detail={summary ? `${formatTokens(summary.observedProviderInputTokens)} in · ${formatTokens(summary.observedProviderOutputTokens)} out` : ""}
                  tag={cachedShare != null && cachedShare > 0 ? { text: `${cachedShare}% cached`, title: "Share of input served from cache" } : null}
                  trend={trendTokens.some((value) => value > 0) ? (
                    <>
                      <UsageSparkline values={trendTokens} label="Daily tokens, last 14 days" />
                      <DeltaTag delta={periodDelta(trendTokens)} title={trendTitle} />
                    </>
                  ) : null}
                />
                <Metric
                  label="Sessions"
                  value={summary ? formatWhole(sessions) : "—"}
                  detail={summary ? `${formatCompact(summary.chatSessions ?? 0)} chats · ${formatCompact(summary.terminalSessions ?? 0)} shells` : ""}
                  trend={trendSessions.some((value) => value > 0) ? (
                    <>
                      <UsageSparkline values={trendSessions} label="Daily sessions, last 14 days" />
                      <DeltaTag delta={periodDelta(trendSessions)} title={trendTitle} />
                    </>
                  ) : null}
                />
                <Metric
                  label="Active days"
                  value={summary?.activeDays != null ? formatWhole(summary.activeDays) : "—"}
                  detail={summary?.activeDays != null && rangeDays > 0
                    ? `of ${formatWhole(rangeDays)} · best run ${formatWhole(summary.longestStreakDays ?? 0)}d`
                    : ""}
                  tag={streak >= 3 ? { text: `${streak}-day streak`, tone: "ok" } : null}
                  trend={trendActive.length > 1 ? (
                    <>
                      <UsageDayStrip days={trendActive} label="Active days, last 14 days" />
                      <span className="usage-delta">{`${trendActive.filter(Boolean).length}/${trendActive.length}`}</span>
                    </>
                  ) : null}
                />
              </div>
              <div className="usage-stats" data-size="sm">
                <Metric
                  size="sm"
                  label="Cached input"
                  source="Providers"
                  value={summary ? formatTokens(summary.observedProviderCachedTokens) : "—"}
                  detail="served from cache"
                />
                <Metric
                  size="sm"
                  label="Output"
                  source="Providers"
                  value={summary ? formatTokens(summary.observedProviderOutputTokens) : "—"}
                  detail={summary ? `${formatSpend(summary.observedProviderCostTodayUsd)} today` : ""}
                />
                <Metric size="sm" label="Lines changed" {...codeMovement} />
                <Metric
                  size="sm"
                  label="Pull requests"
                  source="GitHub"
                  value={summary ? formatWhole(prsTracked) : "—"}
                  detail={summary ? `${formatWhole(prsMerged)} merged` : ""}
                />
              </div>
            </section>

            {/* Whether you can keep going: this machine's live windows. The
                account scope shows the pooled version at the foot instead. */}
            {scope !== "account" ? (
              <section className="kit-card" aria-label="Rate limits">
                <div className="kit-card-head">
                  <span>Rate limits</span>
                  <span className="usage-card-sub">Live on this machine · % left, tick marks a steady pace</span>
                </div>
                <div className="kit-card-body">
                  <UsageLimitGauges />
                </div>
              </section>
            ) : null}

            {/* The shape of the spend. Shares the metric toggle with the
                breakdown so every number below reads in the same units. */}
            <section className="kit-card" aria-label="Spend over time">
              <div className="usage-chart-card-head">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="kit-eyebrow">{`Daily ${effectiveMetric === "tokens" ? "tokens" : "cost"}`}</span>
                  <span className="usage-card-sub">By provider · hover to compare</span>
                </div>
                {chartActions}
              </div>
              <div className="usage-chart-card-body flex flex-col gap-3">
                <UsageChartLegend
                  series={chartSeries}
                  metric={effectiveMetric}
                  theme={theme}
                  highlightedProvider={highlighted}
                  onHighlight={setHighlighted}
                />
                <UsageDailyChart
                  days={days}
                  daily={daily}
                  metric={effectiveMetric}
                  theme={theme}
                  highlightedProvider={highlighted}
                />
              </div>
            </section>

            <section className="kit-card usage-week-card" aria-label="This week against last">
              <div className="usage-chart-card-head">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="kit-eyebrow">{`Week over week · ${effectiveMetric === "tokens" ? "tokens" : "cost"}`}</span>
                  <span className="usage-card-sub">Each day against the same weekday a week earlier</span>
                </div>
              </div>
              <div className="usage-chart-card-body">
                <UsageWeekCompare daily={daily} metric={effectiveMetric} />
              </div>
            </section>

            <div className="usage-grid" data-cols="2">
              <section className="kit-card">
                <div className="kit-card-head">
                  <span>By provider</span>
                  <span className="kit-card-head-count">{(stats?.providers ?? []).filter((provider) => provider.rangeCostUsd > 0 || provider.totalTokens > 0).length}</span>
                </div>
                <div className="kit-card-body">
                  <ProviderCostSplit
                    providers={stats?.providers ?? []}
                    theme={theme}
                    totalCostUsd={summary?.observedProviderCostRangeUsd ?? 0}
                    loading={noStats}
                    highlightedMembers={highlightedMembers}
                    onHighlight={setHighlighted}
                  />
                </div>
              </section>
              <section className="kit-card">
                <div className="kit-card-head">
                  <span>Where the cost went</span>
                </div>
                <div className="kit-card-body">
                  {noStats ? (
                    <span className="usage-footnote">Loading…</span>
                  ) : (
                    <CostComposition providers={stats?.providers ?? []} billing={billing} theme={theme} facts={costFacts} />
                  )}
                </div>
              </section>
            </div>

            {machines.length > 0 ? (
              <div className="usage-grid" data-cols="wide-start">
                {breakdown}
                <section className="kit-card">
                  <div className="kit-card-head">
                    <span>Machines</span>
                    <span className="usage-card-sub">Who reported, and when</span>
                  </div>
                  <div className="kit-card-body" data-flush="true">
                    <MachineList machines={machines} />
                  </div>
                </section>
              </div>
            ) : breakdown}

            <ActivityModule
              stats={stats}
              loading={loading && !stats}
              variant="full"
              preset={preset}
              showRangeControl={false}
              fillSlot
            />

            {/* The host's own caveats about how these numbers were gathered,
                verbatim rather than summarised away. */}
            {sourceNotes.length > 0 ? (
              <p className="usage-footnote">{sourceNotes.join(" · ")}</p>
            ) : null}
          </>
        )}

        <UsageModelDetailDialog
          model={detailModel}
          preset={preset}
          scope={scope}
          theme={theme}
          knownModels={knownModels}
          onClose={() => setDetailModel(null)}
        />

        {/* Pooled live limits belong to the account scope only: "This machine"
            and "This project" are single-environment views, and the top-bar
            popover already carries this machine's limits. Rendered outside the
            historical empty state: live quota is a current reading, so an empty
            date range must not hide a working account's limits. */}
        {scope === "account" && stats?.liveQuota ? (
          <section className="kit-card">
            <div className="kit-card-head">
              <span>Live limits</span>
              <span className="usage-card-sub">Every signed-in machine, pooled. The top bar shows this one.</span>
            </div>
            <div className="kit-card-body">
              <UsagePooledLimits environments={stats.liveQuota.environments} />
            </div>
          </section>
        ) : null}
      </div>
    </SettingsColumn>
  );
}
