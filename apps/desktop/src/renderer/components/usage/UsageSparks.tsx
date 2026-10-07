/**
 * Tiny trend marks for the Usage stat strip: a sparkline (area + line + a dot
 * on today) and an on/off day strip. Both are drawn from the same daily series
 * as the big chart, so the trend under a number cannot disagree with it.
 *
 * Scaled from zero, not from the series minimum: a sparkline that zooms into
 * a 2% wobble makes a flat fortnight look like a crash.
 */
import React from "react";
import "./usageSurfaces.css";

const SPARK_W = 120;

export function UsageSparkline({
  values,
  height = 22,
  color = "color-mix(in srgb, var(--color-fg) 55%, transparent)",
  label,
}: {
  values: readonly number[];
  height?: number;
  color?: string;
  label: string;
}) {
  const gradientId = `spark-${React.useId().replace(/:/g, "")}`;
  if (values.length < 2) return <span className="usage-spark" style={{ height }} aria-hidden />;
  const max = Math.max(...values, 0) || 1;
  const pad = 2;
  const step = SPARK_W / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = pad + (1 - Math.max(0, value) / max) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L ${SPARK_W} ${height} L 0 ${height} Z`;
  const [lastX, lastY] = points[points.length - 1]!;
  return (
    <span className="usage-spark" style={{ height }} role="img" aria-label={label}>
    <svg
      className="usage-spark"
      viewBox={`0 0 ${SPARK_W} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r={1.8} fill={color} />
    </svg>
    </span>
  );
}

/** One square per day: filled when the day had any activity. */
export function UsageDayStrip({ days, label }: { days: readonly boolean[]; label: string }) {
  return (
    <span className="usage-day-strip" role="img" aria-label={label}>
      {days.map((active, index) => (
        <i key={index} data-on={active ? "true" : undefined} />
      ))}
    </span>
  );
}

/**
 * Change between the last `span` days and the `span` before, as a short mono
 * tag ("↑ 12%"). Null when the earlier window is empty: a rise from nothing is
 * not a percentage.
 */
export function periodDelta(values: readonly number[], span = 7): number | null {
  if (values.length < span * 2) return null;
  const recent = values.slice(-span).reduce((sum, value) => sum + value, 0);
  const previous = values.slice(-span * 2, -span).reduce((sum, value) => sum + value, 0);
  if (previous <= 0) return null;
  return Math.round(((recent - previous) / previous) * 100);
}

export function DeltaTag({ delta, title }: { delta: number | null; title?: string }) {
  if (delta == null) return null;
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  return (
    <span className="usage-delta" title={title}>
      {arrow} {Math.abs(delta)}%
    </span>
  );
}
