import React from "react";

import type { AdeUsageDailyPoint } from "../../../shared/types/usage";
import { formatDayShort } from "../../lib/format";
import { usePrefersMoreContrast } from "../../hooks/usePrefersMoreContrast";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import type { ThemeId } from "../../state/appStore";
import { cn } from "../ui/cn";
import { USAGE_OVERLAY_CLASS } from "./usageDesign";
import { humanizeProvider } from "./usageProviderNames";
import {
  USAGE_CHART_COMBINED_ID,
  bucketDayColumns,
  buildDayColumns,
  buildGeometry,
  formatMetric,
  resolveHighlightedSeriesId,
  selectTopSeries,
  seriesColor,
  seriesValue,
  type UsageChartMetric,
  type UsageChartSeries,
} from "./usageDailyChartModel";
import "./usageSurfaces.css";

/**
 * The model is re-exported here so `UsageDailyChart` stays the one import path
 * for the chart, model and component alike, and the split above it is an
 * implementation detail rather than a thing every call site has to know.
 */
export * from "./usageDailyChartModel";

function useElementWidth<T extends HTMLElement>(fallback: number) {
  const [width, setWidth] = React.useState(fallback);
  const observerRef = React.useRef<ResizeObserver | null>(null);

  // A callback ref, not a mount effect. The component renders a *different*
  // element in the empty state than in the plot state, so an effect that
  // captured `ref.current` once would keep observing the unmounted placeholder
  // and the chart would sit on its fallback width forever. The callback is
  // stable (`useCallback` with no deps), so React invokes it only when the
  // observed node actually changes — no per-render observer churn.
  const ref = React.useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      // Snap to whole pixels: sub-pixel jitter would otherwise invalidate the
      // path memo on every scroll-driven layout pass. A zero width (detached or
      // display:none) keeps the last real measurement instead of collapsing the
      // geometry.
      if (next <= 0) return;
      const rounded = Math.round(next);
      setWidth((prev) => (prev === rounded ? prev : rounded));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  React.useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );

  return { ref, width };
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function seriesLabel(series: UsageChartSeries): string {
  if (series.merged || series.id === USAGE_CHART_COMBINED_ID) return series.label;
  return humanizeProvider(series.label);
}

/**
 * Legend chips: swatch · name · range total. Each chip is the series' key and
 * its headline number at once, and hovering one lights its band in the chart
 * (and the matching row elsewhere on the page).
 */
export function UsageChartLegend({
  series,
  metric,
  theme,
  highlightedProvider,
  onHighlight,
  className,
}: {
  series: readonly UsageChartSeries[];
  metric: UsageChartMetric;
  theme: ThemeId;
  highlightedProvider?: string | null;
  onHighlight?: (provider: string | null) => void;
  className?: string;
}) {
  const activeSeriesId = resolveHighlightedSeriesId(series, highlightedProvider);
  if (series.length === 0) return null;
  return (
    <ul className={cn("usage-legend-chips", className)}>
      {series.map((entry) => {
        const dimmed = activeSeriesId != null && activeSeriesId !== entry.id;
        return (
          <li
            key={entry.id}
            className="usage-legend-chip"
            data-dimmed={dimmed ? "true" : undefined}
            onMouseEnter={onHighlight ? () => onHighlight(entry.id) : undefined}
            onMouseLeave={onHighlight ? () => onHighlight(null) : undefined}
          >
            <i aria-hidden style={{ background: seriesColor(entry, theme) }} />
            <span>{seriesLabel(entry)}</span>
            <b>{formatMetric(entry.total, metric)}</b>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

export type UsageDailyChartProps = {
  days: readonly string[];
  daily: readonly AdeUsageDailyPoint[];
  metric: UsageChartMetric;
  theme: ThemeId;
  /**
   * Driven by the parent from hovering a legend chip or a cost row elsewhere
   * on the page. Changing it must only change opacity — never re-derive
   * geometry.
   */
  highlightedProvider?: string | null;
  height?: number;
  className?: string;
  ariaLabel?: string;
};

const FADE_KEYFRAMES = `
@keyframes ade-usage-chart-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

/** Five evenly spaced x labels; fewer when there are fewer points. */
function xTickIndexes(count: number): number[] {
  if (count <= 0) return [];
  const want = Math.min(count, 5);
  const indexes = Array.from({ length: want }, (_, i) =>
    want === 1 ? 0 : Math.round((i / (want - 1)) * (count - 1)),
  );
  return indexes.filter((index, position) => indexes.indexOf(index) === position);
}

/** Axis labels drop the cents a readout keeps: "$200", not "$200.00". */
function formatTick(value: number, metric: UsageChartMetric): string {
  if (metric === "cost" && value >= 10 && value < 1000) return `$${Math.round(value)}`;
  return formatMetric(value, metric);
}

function bucketLabel(date: string, span: number): string {
  return span > 1 ? `Week of ${formatDayShort(date)}` : formatDayShort(date);
}

export function UsageDailyChart({
  days,
  daily,
  metric,
  theme,
  highlightedProvider = null,
  height = 232,
  className,
  ariaLabel,
}: UsageDailyChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const moreContrast = usePrefersMoreContrast();
  const { ref, width } = useElementWidth<HTMLDivElement>(720);
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);
  const gradientPrefix = React.useId().replace(/:/g, "");

  // Data reduction. Keyed on (days, daily, metric) only — hover and highlight
  // are deliberately absent so neither can invalidate it.
  const { columns: dayColumns, providers } = React.useMemo(
    () => buildDayColumns(days, daily, metric),
    [days, daily, metric],
  );

  // Series are ranked over the real days, then long ranges fold into weeks
  // for drawing. Ranking first keeps the legend totals exact.
  const series = React.useMemo(
    () => selectTopSeries(dayColumns, providers),
    [dayColumns, providers],
  );
  const { columns, span } = React.useMemo(() => bucketDayColumns(dayColumns), [dayColumns]);

  // Geometry. Depends on the reduced data plus the measured box — never on
  // hoverIndex or highlightedProvider, so moving the cursor across the plot
  // never rebuilds the path strings.
  const geometry = React.useMemo(
    () => buildGeometry(columns, series, width, height),
    [columns, series, width, height],
  );

  const dayCount = dayColumns.length;
  const pointCount = columns.length;
  const hovered = hoverIndex != null ? columns[hoverIndex] : undefined;

  const handleMove = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (pointCount === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const plotX = event.clientX - rect.left - geometry.plot.left;
      const step = pointCount === 1 ? geometry.plot.width : geometry.plot.width / (pointCount - 1);
      const index = step <= 0 ? 0 : Math.round(plotX / step);
      setHoverIndex(Math.min(pointCount - 1, Math.max(0, index)));
    },
    [pointCount, geometry.plot.left, geometry.plot.width],
  );

  const handleLeave = React.useCallback(() => setHoverIndex(null), []);

  const activeSeriesId = resolveHighlightedSeriesId(series, highlightedProvider);

  const topOpacity = moreContrast ? 0.5 : 0.32;
  const strokeWidth = moreContrast ? 2.25 : 1.5;

  const label = ariaLabel
    ?? `Daily ${metric === "cost" ? "cost" : "token"} usage across ${dayCount} ${
      dayCount === 1 ? "day" : "days"
    }${
      // The single synthetic "all providers" band names no provider, so the
      // label omits the provider count for it.
      series.length === 1 && series[0]?.id === USAGE_CHART_COMBINED_ID
        ? ""
        : ` for ${series.length} ${series.length === 1 ? "provider" : "providers"}`
    }`;

  if (dayCount === 0) {
    return (
      <div ref={ref} className={cn("usage-chart-empty", className)} style={{ height }}>
        No days in range
      </div>
    );
  }

  const hoverX = hoverIndex != null ? geometry.xs[hoverIndex] : undefined;
  const readoutRight = hoverX != null && hoverX > geometry.plot.left + geometry.plot.width / 2;
  const gradientId = (index: number) => `${gradientPrefix}-g${index}`;

  return (
    <div className={cn("flex flex-col", className)}>
      <div
        ref={ref}
        className="usage-chart relative w-full"
        style={{ height }}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
      >
        <svg
          role="img"
          aria-label={label}
          width="100%"
          height={height}
          viewBox={`0 0 ${Math.max(1, width)} ${height}`}
          preserveAspectRatio="none"
          className="block overflow-visible"
        >
          {!reducedMotion ? <style>{FADE_KEYFRAMES}</style> : null}
          <defs>
            {series.map((entry, index) => (
              <linearGradient key={entry.id} id={gradientId(index)} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={seriesColor(entry, theme)} stopOpacity={topOpacity} />
                <stop offset="100%" stopColor={seriesColor(entry, theme)} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          {/* Muted dashed grid + mono y ticks. The baseline is solid. */}
          {geometry.ticks.map((tick, index) => {
            const y = geometry.plot.top + geometry.plot.height * (1 - tick / geometry.max);
            return (
              <g key={tick}>
                <line
                  x1={geometry.plot.left}
                  x2={geometry.plot.left + geometry.plot.width}
                  y1={y}
                  y2={y}
                  className={index === 0 ? "usage-chart-baseline" : "usage-chart-grid"}
                />
                {index % 2 === 0 ? (
                  <text x={geometry.plot.left - 10} y={y + 3} textAnchor="end" className="usage-chart-tick">
                    {formatTick(tick, metric)}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/*
            Layered from a shared zero baseline — NOT stacked, and not by
            accident. In a stack whichever series is drawn last sits
            permanently above the others, so it reads as "that one is bigger"
            even on days when it is the smallest contributor. Every area here
            measures from zero, so two series at the same height mean the same
            number. Do not "fix" this into a stack.

            All fills first, then all strokes, so no series' fill can cover
            another's line.
          */}
          {geometry.paths.map((path, index) => {
            const entry = series[index]!;
            const dimmed = activeSeriesId != null && activeSeriesId !== entry.id;
            return (
              <path
                key={`fill-${path.id}`}
                d={path.area}
                fill={`url(#${gradientId(index)})`}
                stroke="none"
                style={{
                  opacity: dimmed ? 0.1 : 1,
                  transition: reducedMotion ? undefined : "opacity 140ms ease",
                  animation: reducedMotion ? undefined : "ade-usage-chart-fade 260ms ease-out",
                }}
              />
            );
          })}

          {geometry.paths.map((path, index) => {
            const entry = series[index]!;
            const dimmed = activeSeriesId != null && activeSeriesId !== entry.id;
            return (
              <path
                key={`line-${path.id}`}
                d={path.line}
                fill="none"
                stroke={seriesColor(entry, theme)}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                style={{
                  opacity: dimmed ? 0.15 : 1,
                  transition: reducedMotion ? undefined : "opacity 140ms ease",
                }}
              />
            );
          })}

          {/* Hover guide + markers. Reads the same xs the paths were built from. */}
          {hoverX != null ? (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={geometry.plot.top}
                y2={geometry.plot.baseline}
                className="usage-chart-guide"
              />
              {series.map((entry) => {
                const value = hovered ? seriesValue(hovered, entry) : 0;
                if (value <= 0) return null;
                const y = geometry.plot.top
                  + geometry.plot.height * (1 - Math.min(value, geometry.max) / geometry.max);
                return (
                  <circle
                    key={`dot-${entry.id}`}
                    cx={hoverX}
                    cy={y}
                    r={3}
                    fill={seriesColor(entry, theme)}
                    className="usage-chart-dot"
                  />
                );
              })}
            </g>
          ) : null}

          {xTickIndexes(pointCount).map((index, position, all) => (
            <text
              key={`x-${index}`}
              x={geometry.xs[index]}
              y={geometry.plot.baseline + 16}
              textAnchor={position === 0 ? "start" : position === all.length - 1 ? "end" : "middle"}
              className="usage-chart-tick"
            >
              {formatDayShort(columns[index]!.date)}
            </text>
          ))}
        </svg>

        {/*
          Single overlay readout — not one node per day. It consumes `hovered`,
          the very column the paths were drawn from, so the number under the
          cursor cannot drift from the number that was plotted.
        */}
        {hovered ? (
          <div
            className={cn("usage-chart-readout pointer-events-none absolute z-10", USAGE_OVERLAY_CLASS)}
            style={{
              top: geometry.plot.top,
              left: readoutRight ? undefined : (hoverX ?? 0) + 12,
              right: readoutRight ? Math.max(0, width - (hoverX ?? 0) + 12) : undefined,
            }}
          >
            <div className="kit-eyebrow">{bucketLabel(hovered.date, span)}</div>
            <div className="usage-chart-readout-rows">
              {series.map((entry) => {
                const value = seriesValue(hovered, entry);
                if (value <= 0) return null;
                return (
                  <div key={entry.id} className="usage-chart-readout-row">
                    <i aria-hidden style={{ background: seriesColor(entry, theme) }} />
                    <span>{seriesLabel(entry)}</span>
                    <b>{formatMetric(value, metric)}</b>
                  </div>
                );
              })}
            </div>
            <div className="usage-chart-readout-row" data-total="true">
              <span>Total</span>
              <b>{formatMetric(hovered.total, metric)}</b>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default UsageDailyChart;
