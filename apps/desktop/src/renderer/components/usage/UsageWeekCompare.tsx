/**
 * The last seven days against the seven before, day by day, as grouped bars.
 *
 * "Am I using more than last week" is the question the long daily chart is
 * worst at: two weeks are a sliver of a year-long axis. Pairing each day with
 * the same weekday a week earlier answers it directly. The earlier week is a
 * muted foreground, this week carries the accent, and the header states both
 * totals and the change so the bars are a picture of a number already read.
 */
import React from "react";
import type { AdeUsageDailyPoint } from "../../../shared/types";
import { formatMetric, type UsageChartMetric } from "./usageDailyChartModel";
import { DeltaTag, periodDelta } from "./UsageSparks";
import "./usageSurfaces.css";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const PLOT_H = 148;

export function dayMetric(point: AdeUsageDailyPoint, metric: UsageChartMetric): number {
  if (metric === "tokens") return Math.max(0, point.totalTokens || 0);
  return Object.values(point.byProvider ?? {}).reduce((sum, entry) => sum + (entry.costUsd || 0), 0);
}

export function UsageWeekCompare({
  daily,
  metric,
}: {
  /** Contiguous days, oldest first. */
  daily: readonly AdeUsageDailyPoint[];
  metric: UsageChartMetric;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  if (daily.length < 14) {
    return (
      <p className="usage-footnote py-8 text-center">
        Pick a range of 30 days or more to compare this week with the last.
      </p>
    );
  }
  const values = daily.map((point) => dayMetric(point, metric));
  const recent = daily.slice(-7);
  const previous = daily.slice(-14, -7);
  const pairs = recent.map((point, index) => ({
    date: point.date,
    weekday: WEEKDAY[new Date(`${point.date}T12:00:00Z`).getUTCDay()]!,
    now: dayMetric(point, metric),
    before: dayMetric(previous[index]!, metric),
  }));
  const max = Math.max(1e-9, ...pairs.flatMap((pair) => [pair.now, pair.before]));
  const totalNow = pairs.reduce((sum, pair) => sum + pair.now, 0);
  const totalBefore = pairs.reduce((sum, pair) => sum + pair.before, 0);
  const delta = periodDelta(values, 7);
  const shown = hovered != null ? pairs[hovered] : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="usage-fact-value" style={{ fontSize: 22 }}>{formatMetric(totalNow, metric)}</span>
          <DeltaTag delta={delta} title="Last 7 days against the 7 before" />
          <span className="usage-card-sub">vs {formatMetric(totalBefore, metric)} the week before</span>
        </div>
        <div className="usage-mini-legend">
          <span><i style={{ background: "var(--usage-week-before)" }} />Previous 7 days</span>
          <span><i style={{ background: "var(--usage-week-now)" }} />Last 7 days</span>
        </div>
      </div>
      <div>
        <div className="usage-week" role="img" aria-label={`Last 7 days ${formatMetric(totalNow, metric)}, previous 7 days ${formatMetric(totalBefore, metric)}`}>
          {pairs.map((pair, index) => (
            <div
              key={pair.date}
              className="usage-week-bars"
              style={{ height: PLOT_H }}
              data-dimmed={hovered != null && hovered !== index ? "true" : undefined}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            >
              <span data-series="before" style={{ height: `${(pair.before / max) * 100}%` }} />
              <span data-series="now" style={{ height: `${(pair.now / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="usage-week usage-week-labels" aria-hidden>
          {pairs.map((pair, index) => (
            <span key={pair.date}>{index === pairs.length - 1 ? "Today" : pair.weekday}</span>
          ))}
        </div>
      </div>
      <p className="usage-stat-detail m-0" aria-live="polite">
        {shown
          ? `${shown.weekday} · ${formatMetric(shown.now, metric)} this week · ${formatMetric(shown.before, metric)} a week earlier`
          : "Hover a day to compare it with the same weekday a week earlier."}
      </p>
    </div>
  );
}
