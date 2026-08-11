import React from "react";

import type { AdeUsageDailyPoint } from "../../../shared/types/usage";
import { formatDayShort } from "../../lib/format";
import { usePrefersMoreContrast } from "../../hooks/usePrefersMoreContrast";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import type { ThemeId } from "../../state/appStore";
import { cn } from "../ui/cn";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";
import {
  USAGE_HAIRLINE_CLASS,
  USAGE_NUMERIC_CLASS,
  USAGE_OVERLAY_CLASS,
  USAGE_TEXT,
  USAGE_TYPE,
} from "./usageDesign";
import {
  USAGE_CHART_COMBINED_ID,
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

const BRAND_MARKS: Record<string, React.FC<{ size?: number; className?: string }>> = {
  claude: ClaudeLogo,
  anthropic: ClaudeLogo,
  codex: CodexLogo,
  openai: CodexLogo,
};

function SeriesMark({
  series,
  theme,
  size = 14,
}: {
  series: UsageChartSeries;
  theme: ThemeId;
  size?: number;
}) {
  const color = seriesColor(series, theme);
  const Brand = series.merged ? undefined : BRAND_MARKS[series.id.toLowerCase()];
  if (Brand) {
    // The brand mark carries the series colour, so it is the legend swatch —
    // no separate row of colour dots to keep in sync with the paths.
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        style={{ color, width: size, height: size }}
      >
        <Brand size={size} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-[3px]"
      style={{ width: size, height: size, backgroundColor: color }}
    />
  );
}

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
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}>
      {series.map((entry) => {
        const dimmed = activeSeriesId != null && activeSeriesId !== entry.id;
        return (
          <li
            key={entry.id}
            className="flex items-center gap-2 transition-opacity"
            style={{ opacity: dimmed ? 0.35 : 1 }}
            onMouseEnter={onHighlight ? () => onHighlight(entry.id) : undefined}
            onMouseLeave={onHighlight ? () => onHighlight(null) : undefined}
          >
            <SeriesMark series={entry} theme={theme} />
            <span className={cn(USAGE_TEXT.detail, "text-fg")}>
              {entry.label}
            </span>
            <span
              className={cn(USAGE_TEXT.detail, "text-muted-fg", USAGE_NUMERIC_CLASS)}
            >
              {formatMetric(entry.total, metric)}
            </span>
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
   * Driven by the parent from hovering a pace bar elsewhere on the page.
   * Changing it must only change opacity — never re-derive geometry.
   */
  highlightedProvider?: string | null;
  height?: number;
  className?: string;
  ariaLabel?: string;
};

const DRAW_KEYFRAMES = `
@keyframes ade-usage-chart-draw {
  from { stroke-dashoffset: var(--ade-usage-chart-len); }
  to { stroke-dashoffset: 0; }
}
@keyframes ade-usage-chart-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

export function UsageDailyChart({
  days,
  daily,
  metric,
  theme,
  highlightedProvider = null,
  height = 220,
  className,
  ariaLabel,
}: UsageDailyChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const moreContrast = usePrefersMoreContrast();
  const { ref, width } = useElementWidth<HTMLDivElement>(720);
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);

  // Data reduction. Keyed on (days, daily, metric) only — hover and highlight
  // are deliberately absent so neither can invalidate it.
  const { columns, providers } = React.useMemo(
    () => buildDayColumns(days, daily, metric),
    [days, daily, metric],
  );

  const series = React.useMemo(
    () => selectTopSeries(columns, providers),
    [columns, providers],
  );

  // Geometry. Depends on the reduced data plus the measured box — never on
  // hoverIndex or highlightedProvider. This is the whole performance
  // requirement: moving the cursor across 90 days must not rebuild 5 path
  // strings 90 times.
  const geometry = React.useMemo(
    () => buildGeometry(columns, series, width, height),
    [columns, series, width, height],
  );

  const dayCount = columns.length;
  const hovered = hoverIndex != null ? columns[hoverIndex] : undefined;

  const handleMove = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (dayCount === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const plotX = x - geometry.plot.left;
      const step = dayCount === 1 ? geometry.plot.width : geometry.plot.width / (dayCount - 1);
      const index = step <= 0 ? 0 : Math.round(plotX / step);
      setHoverIndex(Math.min(dayCount - 1, Math.max(0, index)));
    },
    [dayCount, geometry.plot.left, geometry.plot.width],
  );

  const handleLeave = React.useCallback(() => setHoverIndex(null), []);

  // Resolved once per render: which drawn band, if any, the page-wide highlight
  // belongs to. See `resolveHighlightedSeriesId`.
  const activeSeriesId = resolveHighlightedSeriesId(series, highlightedProvider);

  const fillOpacity = moreContrast ? 0.3 : 0.14;
  const strokeWidth = moreContrast ? 2.5 : 1.75;

  const label = ariaLabel
    ?? `Daily ${metric === "cost" ? "cost" : "token"} usage across ${dayCount} ${
      dayCount === 1 ? "day" : "days"
    }${
      // The single synthetic "all providers" band names no provider, so the
      // label omits the provider count for it. Read off the series rather than
      // `combined`, which is false for an empty range that still plots one band.
      series.length === 1 && series[0]?.id === USAGE_CHART_COMBINED_ID
        ? ""
        : ` for ${series.length} ${series.length === 1 ? "provider" : "providers"}`
    }`;

  if (dayCount === 0) {
    return (
      <div
        ref={ref}
        className={cn(
          USAGE_TEXT.detail,
          "flex items-center justify-center rounded-lg border bg-card text-muted-fg",
          USAGE_HAIRLINE_CLASS,
          className,
        )}
        style={{ height }}
      >
        No days in range
      </div>
    );
  }

  const hoverX = hoverIndex != null ? geometry.xs[hoverIndex] : undefined;
  const readoutRight = hoverX != null && hoverX > geometry.plot.left + geometry.plot.width / 2;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        ref={ref}
        className="relative w-full"
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
          {!reducedMotion ? <style>{DRAW_KEYFRAMES}</style> : null}

          {/* Gridlines + y ticks */}
          {geometry.ticks.map((tick) => {
            const y = geometry.plot.top + geometry.plot.height * (1 - tick / geometry.max);
            return (
              <g key={tick}>
                <line
                  x1={geometry.plot.left}
                  x2={geometry.plot.left + geometry.plot.width}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-border"
                />
                <text
                  x={geometry.plot.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  fill="currentColor"
                  className={cn("text-muted-fg", USAGE_NUMERIC_CLASS)}
                  style={{ fontSize: USAGE_TYPE.micro }}
                >
                  {formatMetric(tick, metric)}
                </text>
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
                fill={seriesColor(entry, theme)}
                fillOpacity={fillOpacity}
                stroke="none"
                style={{
                  opacity: dimmed ? 0.12 : 1,
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
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-fg"
                opacity={0.5}
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
                    stroke="currentColor"
                    strokeWidth={1.5}
                    className="text-bg"
                  />
                );
              })}
            </g>
          ) : null}

          {/* x ticks: first / middle / last only — one label per day is unreadable. */}
          {[0, Math.floor((dayCount - 1) / 2), dayCount - 1]
            .filter((index, position, all) => all.indexOf(index) === position)
            .map((index) => (
              <text
                key={`x-${index}`}
                x={geometry.xs[index]}
                y={geometry.plot.baseline + 14}
                textAnchor={index === 0 ? "start" : index === dayCount - 1 ? "end" : "middle"}
                fill="currentColor"
                className={cn("text-muted-fg", USAGE_NUMERIC_CLASS)}
                style={{ fontSize: USAGE_TYPE.micro }}
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
            className={cn(
              "pointer-events-none absolute z-10 min-w-[9rem] px-3 py-2",
              USAGE_OVERLAY_CLASS,
            )}
            style={{
              top: geometry.plot.top,
              left: readoutRight ? undefined : (hoverX ?? 0) + 12,
              right: readoutRight ? Math.max(0, width - (hoverX ?? 0) + 12) : undefined,
            }}
          >
            <div className={cn(USAGE_TEXT.micro, "text-muted-fg")}>
              {formatDayShort(hovered.date)}
            </div>
            <div className="mt-1 flex flex-col gap-1">
              {series.map((entry) => {
                const value = seriesValue(hovered, entry);
                if (value <= 0) return null;
                return (
                  <div key={entry.id} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5">
                      <SeriesMark series={entry} theme={theme} size={10} />
                      <span className={cn(USAGE_TEXT.detail, "text-fg")}>
                        {entry.label}
                      </span>
                    </span>
                    <span
                      className={cn(USAGE_TEXT.detail, "text-fg", USAGE_NUMERIC_CLASS)}
                    >
                      {formatMetric(value, metric)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-[color:color-mix(in_srgb,var(--color-border)_60%,transparent)] pt-1.5">
              <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>
                Total
              </span>
              <span
                className={cn(USAGE_TEXT.detail, "text-fg", USAGE_NUMERIC_CLASS)}
              >
                {formatMetric(hovered.total, metric)}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default UsageDailyChart;
