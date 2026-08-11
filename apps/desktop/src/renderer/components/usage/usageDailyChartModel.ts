/**
 * The daily chart's model: data reduction, scale, curve maths, and geometry.
 *
 * Split out of `UsageDailyChart.tsx` — which was a thousand lines with a clean
 * seam halfway down — because none of this is React. It reduces a range of
 * `AdeUsageDailyPoint`s to per-day columns, picks the series worth drawing,
 * and turns those into SVG path strings; the component only measures a box and
 * renders what comes back.
 *
 * Being React-free is load-bearing, not tidiness: `usageTrackingService.test.ts`
 * asserts the main process's daily split against this reducer rather than a
 * re-implementation of it, and importing the component to do that dragged React
 * and the whole `@phosphor-icons` graph into a main-process test.
 *
 * Everything here is re-exported from `UsageDailyChart.tsx`, so no call site
 * needs to know the split happened.
 */
import type { AdeUsageDailyPoint } from "../../../shared/types/usage";
import { formatCompact, formatCost } from "../../lib/format";
import type { ThemeId } from "../../state/appStore";
import { providerColor } from "./providerColors";
import {
  USAGE_CHART_MAX_SERIES,
  USAGE_CHART_OTHER_COLOR,
  USAGE_CHART_OTHER_LABEL,
} from "./usageDesign";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type UsageChartMetric = "cost" | "tokens";

/** Series id used when the host reports no per-provider split at all. */
export const USAGE_CHART_COMBINED_ID = "__combined__";
/** Series id for the merged tail. */
export const USAGE_CHART_OTHER_ID = "__other__";

export const USAGE_CHART_COMBINED_LABEL = "All providers";

/**
 * One day of the range, already reduced to the metric being plotted.
 *
 * The paths, the axis scale, and the hover readout all consume this same array.
 * That is deliberate: if the readout re-derived its numbers from `daily` it
 * could disagree with what was drawn (different rounding, different fallback
 * when `byProvider` is missing), and the number under the cursor would drift
 * from the number in the plot.
 */
export type UsageDayColumn = {
  date: string;
  /** Series id -> value in the selected metric. Only non-zero entries are kept. */
  values: Record<string, number>;
  /** Sum across every provider for the day. */
  total: number;
};

export type UsageDayColumns = {
  columns: UsageDayColumn[];
  /** Every provider id seen across the range, in first-seen order. */
  providers: string[];
  /** True when no day carried a `byProvider` split, so values are flat totals. */
  combined: boolean;
};

export type UsageChartSeries = {
  id: string;
  label: string;
  /** Sum of this series across the whole range, in the selected metric. */
  total: number;
  /** True for the merged tail. */
  merged: boolean;
  /** Provider ids folded into this series (always `[id]` for a plain series). */
  members: string[];
};

// ---------------------------------------------------------------------------
// Pure: day columns
// ---------------------------------------------------------------------------

function metricValue(
  point: { totalTokens: number; costUsd?: number },
  metric: UsageChartMetric,
): number {
  const raw = metric === "cost" ? (point.costUsd ?? 0) : point.totalTokens;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Reduces the raw daily points to one column per day in `days`.
 *
 * `byProvider` is optional on the wire — hosts predating it report only flat
 * totals. That is a real supported state, not an error: when no day in the
 * range carries a split we emit a single combined series built from
 * `totalTokens`, rather than drawing an empty chart.
 *
 * Cost has no flat equivalent, so a combined range in `cost` mode has nothing
 * to plot and yields zero-valued columns; the caller renders the unavailable
 * state for that.
 */
export function buildDayColumns(
  days: readonly string[],
  daily: readonly AdeUsageDailyPoint[],
  metric: UsageChartMetric,
): UsageDayColumns {
  const byDate = new Map<string, AdeUsageDailyPoint>();
  for (const point of daily) {
    if (point && typeof point.date === "string") byDate.set(point.date, point);
  }

  const anySplit = daily.some(
    (point) => !!point?.byProvider && Object.keys(point.byProvider).length > 0,
  );

  // Did the host report anything at all in this range? An entirely empty range
  // looks identical to a split-less one, but it is not evidence that the host
  // *cannot* split — the caller reads `combined` as "this host can't report
  // daily cost" and would show that message for a range that is simply empty.
  const anyData = daily.some(
    (point) =>
      !!point
      && ((point.totalTokens ?? 0) > 0 || Object.keys(point.byProvider ?? {}).length > 0),
  );

  const providers: string[] = [];
  const seen = new Set<string>();
  const columns: UsageDayColumn[] = [];

  for (const date of days) {
    const point = byDate.get(date);
    const values: Record<string, number> = {};
    let total = 0;

    if (!point) {
      columns.push({ date, values, total: 0 });
      continue;
    }

    if (anySplit) {
      const split = point.byProvider ?? {};
      for (const provider of Object.keys(split)) {
        const value = metricValue(split[provider]!, metric);
        if (value <= 0) continue;
        values[provider] = (values[provider] ?? 0) + value;
        total += value;
        if (!seen.has(provider)) {
          seen.add(provider);
          providers.push(provider);
        }
      }
    } else {
      // No split anywhere in the range: one combined series from flat totals.
      const value = metricValue(
        { totalTokens: point.totalTokens ?? 0, costUsd: 0 },
        metric,
      );
      if (value > 0) {
        values[USAGE_CHART_COMBINED_ID] = value;
        total = value;
        if (!seen.has(USAGE_CHART_COMBINED_ID)) {
          seen.add(USAGE_CHART_COMBINED_ID);
          providers.push(USAGE_CHART_COMBINED_ID);
        }
      }
    }

    columns.push({ date, values, total });
  }

  if (!anySplit && providers.length === 0 && days.length > 0) {
    // Range exists but is entirely empty (or cost mode with no split available).
    // Still report the single combined series so the chart renders one flat
    // baseline instead of switching shape when the first non-zero day lands.
    providers.push(USAGE_CHART_COMBINED_ID);
  }

  // `combined` means "this range is a single flat series because the host never
  // split it" — a statement about the host, so it needs data to be true of.
  return { columns, providers, combined: !anySplit && anyData };
}

// ---------------------------------------------------------------------------
// Pure: series selection (top N + Other)
// ---------------------------------------------------------------------------

/**
 * Picks the heaviest `maxSeries` providers over the whole range and folds the
 * remainder into one neutral "Other" series.
 *
 * Ties break on provider id so the ordering is stable across refreshes — a
 * chart whose colours reshuffle when two providers happen to match is worse
 * than one that picks an arbitrary but fixed winner.
 *
 * Selection walks each column once (O(days x providers)); no nested rescan.
 */
export function selectTopSeries(
  columns: readonly UsageDayColumn[],
  providers: readonly string[],
  maxSeries: number = USAGE_CHART_MAX_SERIES,
): UsageChartSeries[] {
  const totals = new Map<string, number>();
  for (const provider of providers) totals.set(provider, 0);
  for (const column of columns) {
    for (const provider of Object.keys(column.values)) {
      totals.set(provider, (totals.get(provider) ?? 0) + column.values[provider]!);
    }
  }

  const ranked = [...totals.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  const limit = Math.max(1, maxSeries);
  const head = ranked.slice(0, limit);
  const tail = ranked.slice(limit);

  const series: UsageChartSeries[] = head.map(([id, total]) => ({
    id,
    label: id === USAGE_CHART_COMBINED_ID ? USAGE_CHART_COMBINED_LABEL : id,
    total,
    merged: false,
    members: [id],
  }));

  if (tail.length > 0) {
    series.push({
      id: USAGE_CHART_OTHER_ID,
      label: USAGE_CHART_OTHER_LABEL,
      total: tail.reduce((sum, entry) => sum + entry[1], 0),
      merged: true,
      members: tail.map((entry) => entry[0]),
    });
  }

  return series;
}

/**
 * Which drawn series a highlighted provider belongs to, or `null` when none of
 * them do.
 *
 * The highlight travels between three surfaces that do not share an id space:
 * the cost split and the limits band speak provider ids, the chart draws at
 * most `USAGE_CHART_MAX_SERIES` of them plus a merged "Other". Comparing
 * `series.id !== highlighted` directly got both edges wrong — hovering a
 * provider folded into "Other" faded the very band containing it, and hovering
 * a provider the chart does not draw at all faded *every* band, so the whole
 * plot greyed out for no visible reason. Resolving to the owning series first
 * means an unrepresented provider highlights nothing rather than dimming
 * everything.
 */
export function resolveHighlightedSeriesId(
  series: readonly UsageChartSeries[],
  provider: string | null | undefined,
): string | null {
  if (!provider) return null;
  for (const entry of series) {
    if (entry.id === provider || entry.members.includes(provider)) return entry.id;
  }
  return null;
}

/** Value of one (possibly merged) series on one day. */
export function seriesValue(column: UsageDayColumn, series: UsageChartSeries): number {
  if (!series.merged) return column.values[series.id] ?? 0;
  let sum = 0;
  for (const member of series.members) sum += column.values[member] ?? 0;
  return sum;
}

// ---------------------------------------------------------------------------
// Pure: scale
// ---------------------------------------------------------------------------

/**
 * Rounds a peak UP to the nearest 1/2/5 x 10^n step.
 *
 * Up, never down. A "nice" max below the observed peak draws the tallest day
 * past the top of the plot, where the clip hides exactly the spike the user
 * opened the chart to look at.
 */
export function niceScale(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1;
  const exponent = Math.floor(Math.log10(peak));
  const power = Math.pow(10, exponent);
  const fraction = peak / power;
  // Epsilon absorbs float error (0.3 / 0.1 === 3.0000000000000004), which would
  // otherwise promote an exact 1/2/5 peak to the next step for no reason.
  const eps = 1e-9;
  const step = fraction <= 1 + eps ? 1 : fraction <= 2 + eps ? 2 : fraction <= 5 + eps ? 5 : 10;
  return step * power;
}

/**
 * Peak = largest single provider-day, NOT the largest daily sum.
 *
 * Every series is drawn from the same zero baseline (see the layering note on
 * the component), so nothing ever reaches the sum of a day. Scaling to the sum
 * would squash the whole chart into the bottom third on any day with several
 * active providers.
 */
export function computePeak(
  columns: readonly UsageDayColumn[],
  series: readonly UsageChartSeries[],
): number {
  let peak = 0;
  for (const column of columns) {
    for (const entry of series) {
      const value = seriesValue(column, entry);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

// ---------------------------------------------------------------------------
// Pure: monotone cubic smoothing (Fritsch-Carlson)
// ---------------------------------------------------------------------------

export type CurveSegment = {
  x0: number;
  y0: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x1: number;
  y1: number;
};

/**
 * Fritsch-Carlson tangents.
 *
 * Plain (Catmull-Rom / natural) cubic smoothing overshoots on spiky daily data
 * and dips the interpolant below the samples between two points. On a usage
 * chart that renders as the area crossing under zero — visually, negative
 * spend. Monotone tangents are limited so each segment stays inside the range
 * of its own endpoints, which makes that impossible.
 */
export function monotoneTangents(xs: readonly number[], ys: readonly number[]): number[] {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return [];
  if (n === 1) return [0];

  const slopes: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const dx = xs[i + 1]! - xs[i]!;
    slopes[i] = dx === 0 ? 0 : (ys[i + 1]! - ys[i]!) / dx;
  }

  const tangents: number[] = new Array(n);
  tangents[0] = slopes[0]!;
  tangents[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i += 1) {
    const prev = slopes[i - 1]!;
    const next = slopes[i]!;
    // A local extremum must be flat, otherwise the curve overshoots past it.
    tangents[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }

  for (let i = 0; i < n - 1; i += 1) {
    const slope = slopes[i]!;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = tangents[i]! / slope;
    const b = tangents[i + 1]! / slope;
    const magnitude = Math.hypot(a, b);
    if (magnitude > 3) {
      const scale = 3 / magnitude;
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }

  return tangents;
}

/** Cubic Bezier control points for the monotone interpolant through the samples. */
export function monotoneSegments(
  xs: readonly number[],
  ys: readonly number[],
): CurveSegment[] {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return [];
  const tangents = monotoneTangents(xs, ys);
  const segments: CurveSegment[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const dx = xs[i + 1]! - xs[i]!;
    segments[i] = {
      x0: xs[i]!,
      y0: ys[i]!,
      c1x: xs[i]! + dx / 3,
      c1y: ys[i]! + (tangents[i]! * dx) / 3,
      c2x: xs[i + 1]! - dx / 3,
      c2y: ys[i + 1]! - (tangents[i + 1]! * dx) / 3,
      x1: xs[i + 1]!,
      y1: ys[i + 1]!,
    };
  }
  return segments;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** SVG path `d` for the smoothed line through the samples. */
export function smoothCurve(xs: readonly number[], ys: readonly number[]): string {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return "";
  if (n === 1) return `M ${round(xs[0]!)} ${round(ys[0]!)}`;
  const segments = monotoneSegments(xs, ys);
  let d = `M ${round(segments[0]!.x0)} ${round(segments[0]!.y0)}`;
  for (const segment of segments) {
    d += ` C ${round(segment.c1x)} ${round(segment.c1y)} ${round(segment.c2x)} ${round(
      segment.c2y,
    )} ${round(segment.x1)} ${round(segment.y1)}`;
  }
  return d;
}

/** Evaluates one segment at `t` in [0,1]. Exported for the overshoot test. */
export function evaluateSegment(segment: CurveSegment, t: number): number {
  const u = 1 - t;
  return (
    u * u * u * segment.y0
    + 3 * u * u * t * segment.c1y
    + 3 * u * t * t * segment.c2y
    + t * t * t * segment.y1
  );
}

// ---------------------------------------------------------------------------
// Pure: geometry
// ---------------------------------------------------------------------------

export type UsageChartPlot = {
  left: number;
  top: number;
  width: number;
  height: number;
  baseline: number;
};

export type UsageChartPaths = {
  id: string;
  line: string;
  area: string;
};

export type UsageChartGeometry = {
  plot: UsageChartPlot;
  xs: number[];
  max: number;
  ticks: number[];
  paths: UsageChartPaths[];
};

const PAD = { left: 46, right: 10, top: 14, bottom: 22 } as const;

export function buildGeometry(
  columns: readonly UsageDayColumn[],
  series: readonly UsageChartSeries[],
  width: number,
  height: number,
): UsageChartGeometry {
  const plot: UsageChartPlot = {
    left: PAD.left,
    top: PAD.top,
    width: Math.max(1, width - PAD.left - PAD.right),
    height: Math.max(1, height - PAD.top - PAD.bottom),
    baseline: height - PAD.bottom,
  };

  const n = columns.length;
  const xs: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = n === 1 ? plot.left + plot.width / 2 : plot.left + (i / (n - 1)) * plot.width;
  }

  const max = niceScale(computePeak(columns, series));
  const toY = (value: number) => plot.top + plot.height * (1 - Math.min(value, max) / max);

  const paths: UsageChartPaths[] = series.map((entry) => {
    const ys: number[] = new Array(n);
    for (let i = 0; i < n; i += 1) ys[i] = toY(seriesValue(columns[i]!, entry));

    if (n === 0) return { id: entry.id, line: "", area: "" };
    if (n === 1) {
      const x = xs[0]!;
      const y = ys[0]!;
      const halfTick = 6;
      const line = `M ${round(x - halfTick)} ${round(y)} L ${round(x + halfTick)} ${round(y)}`;
      const area = `${line} L ${round(x + halfTick)} ${round(plot.baseline)} L ${round(
        x - halfTick,
      )} ${round(plot.baseline)} Z`;
      return { id: entry.id, line, area };
    }

    const line = smoothCurve(xs, ys);
    const area = `${line} L ${round(xs[n - 1]!)} ${round(plot.baseline)} L ${round(
      xs[0]!,
    )} ${round(plot.baseline)} Z`;
    return { id: entry.id, line, area };
  });

  return { plot, xs, max, ticks: [0, max / 2, max], paths };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * An axis tick or a readout figure, in the plotted metric.
 *
 * Both branches defer to `lib/format` rather than repeating its arithmetic:
 * this used to print `1.2k` where the metric strip six inches above printed
 * `1.2K` for the same number. The zero cases stay bare — an axis reading
 * `$0.00` is noise where `$0` is a baseline.
 */
export function formatMetric(value: number, metric: UsageChartMetric): string {
  if (metric === "cost") {
    if (value === 0) return "$0";
    if (value < 1000) return formatCost(value);
    return `$${formatCompact(value)}`;
  }
  if (value === 0) return "0";
  return formatCompact(value);
}

export function seriesColor(series: UsageChartSeries, theme: ThemeId): string {
  if (series.merged) return USAGE_CHART_OTHER_COLOR;
  if (series.id === USAGE_CHART_COMBINED_ID) return "var(--color-accent)";
  return providerColor(series.id, theme);
}
