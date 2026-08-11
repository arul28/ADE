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
  AdeUsageDailyPoint,
  AdeUsageMachineContribution,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRangePreset,
  AdeUsageScope,
  AdeUsageStats,
} from "../../../shared/types";
import { formatCost, formatTokens, relativeTimeCompact } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { ActivityModule, RANGE_OPTIONS } from "../usage/ActivityModule";
import { providerColor } from "../usage/providerColors";
import { cn } from "../ui/cn";
import {
  UsageChartLegend,
  UsageDailyChart,
  buildDayColumns,
  selectTopSeries,
} from "../usage/UsageDailyChart";
import { UsageSegmented } from "../usage/UsageSegmented";
import {
  USAGE_BUTTON_CLASS,
  USAGE_CARD_CLASS,
  USAGE_DIVIDER_COLOR_CLASS,
  USAGE_EYEBROW_CLASS,
  USAGE_HAIRLINE_CLASS,
  USAGE_HOVER_ROW_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_PANEL_HEADER_CLASS,
  USAGE_TEXT,
} from "../usage/usageDesign";
import { formatUpdatedAge } from "../usage/usageWindowFormat";

const SCOPE_STORAGE_KEY = "ade.stats.scope.v1";
const RANGE_STORAGE_KEY = "ade.stats.range.v1";
/*
 * Live quota is deliberately absent from this page.
 *
 * The top-bar usage meter already answers "how much quota is left", it is on
 * screen in every tab, and it updates continuously. A second copy here — even
 * behind a disclosure — put the least relevant thing on a page about spend and
 * history directly in the reading path. The meter's popover links back here for
 * the fuller history, which is the direction that actually gets used.
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

function formatUsd(value: number): string {
  return value > 0 ? formatCost(value) : "$0.00";
}

function humanizeProvider(provider: string): string {
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    claude: "Claude",
    codex: "Codex",
    copilot: "Copilot",
    cursor: "Cursor",
    "cursor-agent": "Cursor Agent",
    deepseek: "DeepSeek",
    droid: "Droid",
    gemini: "Gemini",
    google: "Google",
    lmstudio: "LM Studio",
    mistral: "Mistral",
    ollama: "Ollama",
    opencode: "OpenCode",
    openai: "OpenAI",
    openclaw: "OpenClaw",
    openrouter: "OpenRouter",
    xai: "xAI",
  };
  const normalized = provider.trim().toLowerCase();
  return (
    known[normalized] ??
    provider
      .split(/[-_/\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
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

/** One cell of the metric strip. */
function Metric({
  label,
  value,
  detail,
  source,
}: {
  label: string;
  value: string;
  detail: string;
  source?: MetricSource;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 bg-surface-raised px-5 py-4 hover:bg-muted",
        USAGE_HOVER_ROW_CLASS,
      )}
    >
      <span className={cn(USAGE_TEXT.micro, "flex items-baseline justify-between gap-2 text-muted-fg")}>
        <span className="min-w-0 truncate">{label}</span>
        {source ? <span className="shrink-0 text-muted-fg/70">{source}</span> : null}
      </span>
      <span className={cn(USAGE_TEXT.title, USAGE_NUMERIC_CLASS, "text-fg")}>{value}</span>
      <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>{detail}</span>
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
 * A titled band of the page.
 *
 * The page previously ran section headings straight onto the page background,
 * which is why it read as one undifferentiated sheet — "everything feels like
 * chalk". Each band is now the same card surface the rest of the app uses, so
 * the page has the layering ADE has everywhere else.
 */
function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn(USAGE_CARD_CLASS, "overflow-hidden", className)}>
      {title || actions ? (
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 px-6 py-3.5",
            USAGE_PANEL_HEADER_CLASS,
          )}
        >
          {title ? <h2 className={cn(USAGE_TEXT.body, "m-0 font-medium text-fg")}>{title}</h2> : <span />}
          {actions ? <div className="flex items-center gap-4">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn("p-6", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * The cost hero.
 *
 * The asterisk is a real explanation, not decoration: unlike tools that read
 * exact token counts out of provider transcripts, some of our ledgers estimate
 * tokens from character counts, so this figure has two independent sources of
 * softness and the reader deserves to know which apply.
 */
function CostHero({
  costUsd,
  providers,
  loading,
  pricingUpdatedAt,
}: {
  costUsd: number;
  providers: AdeUsageProviderSummary[];
  loading: boolean;
  /** When the public rate list was last fetched; null = built-in rates only. */
  pricingUpdatedAt?: string | null;
}) {
  const estimated = providers
    .map((provider) => {
      const note = estimationNote(provider.estimation);
      return note ? `${humanizeProvider(provider.provider)}: ${note}` : null;
    })
    .filter((entry): entry is string => entry !== null);

  const ratesNote = describeRatesSource(providers, pricingUpdatedAt);

  const footnote =
    estimated.length === 0
      ? "if billed at full API rate"
      : `if billed at full API rate — ${estimated.length === 1 ? "one provider is" : `${estimated.length} providers are`} estimated`;

  return (
    <div className="flex flex-col gap-2">
      <span className={USAGE_EYEBROW_CLASS}>Estimated cost</span>
      <span className={cn(USAGE_TEXT.hero, USAGE_NUMERIC_CLASS, "font-semibold text-fg")}>
        {loading ? "—" : `${formatUsd(costUsd)}*`}
      </span>
      <span
        className={cn(USAGE_TEXT.micro, "cursor-help text-muted-fg")}
        title={[
          estimated.length > 0
            ? `Not money spent — subscriptions bill separately.\n\n${estimated.join("\n")}`
            : "Not money spent — subscriptions bill separately. Token counts are provider-reported.",
          ratesNote,
        ].filter(Boolean).join("\n\n")}
      >
        * {footnote}
      </span>
    </div>
  );
}

/** Per-provider share of the range's cost, ranked. */
function ProviderCostSplit({
  providers,
  theme,
  highlightedMembers,
  onHighlight,
}: {
  providers: AdeUsageProviderSummary[];
  theme: "dark" | "light";
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

  if (ranked.length === 0) return null;

  return (
    // ADE tracks nine providers. Uncapped, this column grows taller than the
    // chart beside it and drags the panel — and the metric strip below it — down
    // past the fold on a machine that has used most of them. The list scrolls
    // inside its own bounds instead, and the cap is tall enough that the four or
    // five providers a typical machine reports never scroll at all.
    <div className="-mx-2 flex max-h-[19rem] flex-col gap-1 overflow-y-auto px-2 py-1">
      {ranked.map((provider) => {
        const share = total > 0 ? provider.rangeCostUsd / total : 0;
        const color = providerColor(provider.provider, theme);
        const focused = highlightedMembers?.has(provider.provider) ?? false;
        const dimmed = highlightedMembers !== null && !focused;
        return (
          <div
            key={provider.provider}
            className={cn(
              "flex flex-col gap-1.5 rounded-md px-2 py-1.5",
              USAGE_HOVER_ROW_CLASS,
              dimmed && "opacity-40",
            )}
            // The hovered provider tints in its own brand colour rather than a
            // neutral grey, so the row, its bar, and its band in the chart are
            // all obviously the same thing.
            style={focused ? { background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
            onMouseEnter={() => onHighlight(provider.provider)}
            onMouseLeave={() => onHighlight(null)}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className={cn(USAGE_TEXT.body, "flex items-center gap-2 text-fg")}>
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full transition-shadow duration-150 motion-reduce:transition-none"
                  style={{
                    background: color,
                    boxShadow: focused ? `0 0 0 3px color-mix(in srgb, ${color} 28%, transparent)` : undefined,
                  }}
                />
                {humanizeProvider(provider.provider)}
              </span>
              <span className={cn(USAGE_TEXT.body, USAGE_NUMERIC_CLASS, "text-fg")}>
                {formatUsd(provider.rangeCostUsd)}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${(share * 100).toFixed(1)}%`, background: color }}
              />
            </div>
            <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "text-muted-fg")}>
              {`${Math.round(share * 100)}% of cost · ${formatTokens(provider.totalTokens)} tokens`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Top models by cost. */
function ModelBreakdown({ models, theme }: { models: AdeUsageModelSummary[]; theme: "dark" | "light" }) {
  const top = models.slice(0, 10);
  const total = models.reduce((sum, model) => sum + Math.max(0, model.costUsd), 0);

  return (
    <>
      {top.length === 0 ? (
        <p className={cn(USAGE_TEXT.detail, "py-6 text-center text-muted-fg")}>
          No model activity in this range.
        </p>
      ) : (
        <table className={cn(USAGE_TEXT.detail, "w-full")}>
          <thead>
            <tr
              className={cn(
                USAGE_TEXT.micro,
                "border-b text-left text-muted-fg",
                USAGE_HAIRLINE_CLASS,
              )}
            >
              <th className="py-2 font-normal">Model</th>
              <th className="py-2 text-right font-normal">Cost</th>
              <th className="py-2 text-right font-normal">Share</th>
              <th className="py-2 text-right font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {top.map((model) => {
              const cost = model.costUsd;
              const share = total > 0 ? cost / total : 0;
              return (
                <tr
                  key={`${model.provider}:${model.model}`}
                  className={cn(
                    "border-b last:border-b-0 hover:bg-muted",
                    USAGE_DIVIDER_COLOR_CLASS,
                    USAGE_HOVER_ROW_CLASS,
                  )}
                >
                  <td className="py-2 pl-2 text-fg">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: providerColor(model.provider, theme) }}
                      />
                      {model.model}
                    </span>
                  </td>
                  <td className={cn("py-2 text-right text-fg", USAGE_NUMERIC_CLASS)}>{formatUsd(cost)}</td>
                  <td className={cn("py-2 text-right text-muted-fg", USAGE_NUMERIC_CLASS)}>
                    {`${Math.round(share * 100)}%`}
                  </td>
                  <td className={cn("py-2 pr-2 text-right text-muted-fg", USAGE_NUMERIC_CLASS)}>
                    {formatTokens(model.totalTokens)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
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
      <span className={cn(USAGE_TEXT.micro, "flex items-center gap-2 text-muted-fg")}>
        Cost isn&apos;t tracked per project
        <button
          type="button"
          onClick={onShowMachine}
          className={cn(USAGE_BUTTON_CLASS, "min-h-7 px-2 py-1")}
        >
          Show this machine
        </button>
      </span>
    );
  }
  return (
    <span
      className={cn(USAGE_TEXT.micro, "text-muted-fg")}
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
  // The clock lives here, not on the page.
  //
  // It used to tick page-level state every 15s, which re-rendered the whole
  // Usage page — the 365-column daily chart included — to age one relative
  // timestamp in a panel that only renders when there are other machines to
  // list, and is usually below the fold. Owning it here scopes the re-render to
  // the rows that actually read it, and costs nothing at all when the panel is
  // not mounted.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), MACHINE_FRESHNESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  if (machines.length === 0) return null;
  return (
    <dl className="m-0 flex flex-col">
      {machines.map((machine) => (
          <div
            key={machine.machineKey}
            className={cn(
              "-mx-2 flex items-baseline justify-between gap-3 rounded-md border-b last:border-b-0 px-2 py-2 hover:bg-muted",
              USAGE_DIVIDER_COLOR_CLASS,
              USAGE_HOVER_ROW_CLASS,
            )}
          >
            <dt className={cn(USAGE_TEXT.detail, "flex items-center gap-2 text-fg")}>
              <span aria-hidden className="text-muted-fg">
                {platformGlyph(machine.platform)}
              </span>
              {machine.label.trim() || machine.machineKey}
              {machine.state === "deduped" && machine.dedupedAgainstMachineKey ? (
                <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>
                  counted once with {machine.dedupedAgainstMachineKey}
                </span>
              ) : null}
            </dt>
            {/* The merge writes a plain-language reason for failed and stale
                machines; prefer it over a generic label so the row says what
                actually happened. */}
            <dd className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "text-muted-fg")}>
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
          `${formatUsd(undated)} of this total comes from records with no date and isn't on the daily chart.`,
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

  return (
    <div className="flex flex-col gap-6">
      {/* The Settings shell already prints "Usage" and its one-line
          description above this component, so the page does not print them a
          second time. What the shell cannot know — which range is on screen and
          how old the reading is — sits with the controls that change it. */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className={cn(USAGE_TEXT.detail, USAGE_NUMERIC_CLASS, "m-0 text-muted-fg")}>
          {formatRangeLabel(stats)}
          {updatedLabel ? ` · updated ${updatedLabel} ago` : ""}
        </p>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <UsageSegmented
            ariaLabel="Usage scope"
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
            className={cn(USAGE_TEXT.micro, USAGE_BUTTON_CLASS, "min-h-8 px-3")}
          >
            <ArrowClockwise size={13} className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? (
        <div className={cn(USAGE_CARD_CLASS, USAGE_TEXT.detail, "px-6 py-4 text-muted-fg")}>{error}</div>
      ) : null}

      {isEmpty ? (
        <div className={cn(USAGE_CARD_CLASS, "flex flex-col items-center gap-2 px-6 py-16 text-center")}>
          <span className={cn(USAGE_TEXT.body, "font-medium text-fg")}>Nothing here yet</span>
          <span className={cn(USAGE_TEXT.detail, "max-w-[46ch] text-muted-fg")}>
            Your first Claude or Codex turn shows up within a minute.
          </span>
        </div>
      ) : (
        <>
          {/* Cost first, then the shape of it. The summary and the chart follow
              the same metric toggle so the headline and the series are always
              reading in the same units. */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <Panel bodyClassName="flex flex-col gap-5">
              <CostHero
                costUsd={summary?.observedProviderCostRangeUsd ?? 0}
                providers={stats?.providers ?? []}
                // `!stats` on its own, not `loading && !stats`: a load that
                // failed with nothing cached clears `loading` while `stats`
                // stays null, and the hero then printed a confident "$0.00"
                // over an error banner. No data is not zero.
                loading={loading || !stats}
                pricingUpdatedAt={stats?.pricingUpdatedAt}
              />
              <ProviderCostSplit
                providers={stats?.providers ?? []}
                theme={theme}
                highlightedMembers={highlightedMembers}
                onHighlight={setHighlighted}
              />
            </Panel>

            <Panel
              title={`Daily ${effectiveMetric === "tokens" ? "tokens" : "cost"}`}
              actions={
                <>
                  {costChartUnavailable ? (
                    <ChartCostUnavailable
                      scope={scope}
                      onShowMachine={() => changeScope("machine")}
                    />
                  ) : (
                    <UsageSegmented
                      ariaLabel="Chart metric"
                      options={[
                        { value: "cost", label: "Cost" },
                        { value: "tokens", label: "Tokens" },
                      ]}
                      value={metric}
                      onChange={setMetric}
                    />
                  )}
                  <UsageChartLegend
                    series={chartSeries}
                    metric={effectiveMetric}
                    theme={theme}
                    highlightedProvider={highlighted}
                    onHighlight={setHighlighted}
                  />
                </>
              }
            >
              <UsageDailyChart
                days={days}
                daily={daily}
                metric={effectiveMetric}
                theme={theme}
                highlightedProvider={highlighted}
              />
            </Panel>
          </div>

          <section
            className={cn(
              "grid grid-cols-2 gap-px overflow-hidden md:grid-cols-5",
              USAGE_CARD_CLASS,
              // The seams between cells are the card's own hairline showing
              // through a 1px grid gap, not a second, harder rule.
              "bg-[color:color-mix(in_srgb,var(--color-border)_75%,var(--color-surface-raised))]",
            )}
          >
            <Metric
              label="Processed tokens"
              source="Providers"
              value={summary ? formatTokens(summary.totalTokens) : "—"}
              detail={summary ? `${formatTokens(summary.observedProviderInputTokens)} in` : ""}
            />
            <Metric
              label="Cached input"
              source="Providers"
              value={summary ? formatTokens(summary.observedProviderCachedTokens) : "—"}
              detail="reads served from cache"
            />
            <Metric
              label="Output"
              source="Providers"
              value={summary ? formatTokens(summary.observedProviderOutputTokens) : "—"}
              detail={summary ? `${formatUsd(summary.observedProviderCostTodayUsd)} today` : ""}
            />
            <Metric label="Lines changed" {...codeMovement} />
            <Metric
              label="Pull requests"
              source="GitHub"
              value={summary ? formatWhole(prsTracked) : "—"}
              detail={summary ? `${formatWhole(prsMerged)} merged` : ""}
            />
          </section>

          {/* The activity module brings its own card, so this band is a heading
              and the module — not a card inside a card. */}
          <section className="flex flex-col gap-3">
            <h2 className={cn(USAGE_TEXT.body, "m-0 font-medium text-fg")}>Activity</h2>
            <ActivityModule
              stats={stats}
              loading={loading && !stats}
              variant="full"
              preset={preset}
              showRangeControl={false}
            />
          </section>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
            <Panel title="Breakdown">
              <ModelBreakdown models={stats?.models ?? []} theme={theme} />
            </Panel>
            {machines.length > 0 ? (
              <Panel title="Machines">
                <MachineList machines={machines} />
              </Panel>
            ) : null}
          </div>

          {/* Host-provided caveats about how these numbers were gathered. They
              are the host's own words about its data, so they are surfaced
              verbatim rather than summarised away. */}
          {sourceNotes.length > 0 ? (
            <p className={cn(USAGE_TEXT.micro, "m-0 leading-relaxed text-muted-fg")}>
              {sourceNotes.join(" · ")}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
