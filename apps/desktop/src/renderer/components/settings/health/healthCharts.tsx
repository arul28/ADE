/**
 * Small hand-drawn charts for the project and service settings pages, in the
 * Usage tab's style:
 * flat bars, one hue per series, at most four series plus a neutral "Other",
 * a legend that names every segment with its value (identity never rests on
 * colour alone), tabular mono numbers and a hover readout.
 *
 * Colours are the Usage tab's validated categorical palette (`SPLIT_COLORS`),
 * light and dark.
 */
import React from "react";
import { SPLIT_COLORS } from "../../usage/UsageCostSplit";
import { useAppStore } from "../../../state/appStore";
import { formatBytes } from "../../../lib/format";
import { formatMeasuredBytes, type ChartSeries, type LaneBar } from "../storage/storageView";
import "../../usage/usageSurfaces.css";

type Theme = "dark" | "light";

const SERIES_HUES = [SPLIT_COLORS.input, SPLIT_COLORS.cacheWrite, SPLIT_COLORS.output, SPLIT_COLORS.ultrafast] as const;

export function useChartTheme(): Theme {
  return useAppStore((state) => state.theme) === "light" ? "light" : "dark";
}

/** The hue for the series at `index`; "Other" is always neutral. */
export function seriesColor(index: number, id: string, theme: Theme): string {
  if (id === "other") return SPLIT_COLORS.neutral[theme];
  return SERIES_HUES[index % SERIES_HUES.length]![theme];
}

/**
 * One part-to-whole bar with a legend: what ADE keeps, by category. A share
 * that is a lower bound is labelled "≥".
 */
export function StackedBreakdown({ series, ariaLabel }: { series: ChartSeries[]; ariaLabel: string }) {
  const theme = useChartTheme();
  const [hovered, setHovered] = React.useState<string | null>(null);
  const total = series.reduce((sum, entry) => sum + Math.max(0, entry.bytes), 0);
  if (series.length === 0 || total <= 0) return null;
  return (
    <div className="usage-split ade-health-split" role="group" aria-label={ariaLabel}>
      <div
        className="usage-split-bar ade-health-bar"
        role="img"
        aria-label={series.map((entry) => `${entry.label} ${formatMeasuredBytes(entry.bytes, entry.partial)}`).join(", ")}
      >
        {series.map((entry, index) => (
          <span
            key={entry.id}
            style={{
              flexGrow: Math.max(entry.bytes, total * 0.004),
              flexBasis: 0,
              background: seriesColor(index, entry.id, theme),
              opacity: hovered && hovered !== entry.id ? 0.3 : 1,
            }}
            title={`${entry.members.join(", ")} · ${formatMeasuredBytes(entry.bytes, entry.partial)} · ${Math.round((entry.bytes / total) * 100)}%`}
            onMouseEnter={() => setHovered(entry.id)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>
      <div className="usage-split-legend">
        {series.map((entry, index) => (
          <span
            key={entry.id}
            className="usage-split-legend-item"
            style={hovered === entry.id ? { color: "var(--color-fg)" } : undefined}
            title={entry.id === "other" ? entry.members.join(", ") : undefined}
            onMouseEnter={() => setHovered(entry.id)}
            onMouseLeave={() => setHovered(null)}
          >
            <i aria-hidden style={{ background: seriesColor(index, entry.id, theme) }} />
            {entry.label}
            <b>{formatMeasuredBytes(entry.bytes, entry.partial)}</b>
            <em>{`${Math.round((entry.bytes / total) * 100)}%`}</em>
          </span>
        ))}
      </div>
    </div>
  );
}

const LANE_STATUS_TAG: Record<string, string> = {
  archived: "Archived",
  orphaned: "Left over",
};

/** The largest lanes as horizontal bars, scaled to the largest. */
export function LaneBars({ bars }: { bars: LaneBar[] }) {
  const max = Math.max(...bars.map((bar) => bar.bytes), 1);
  if (bars.length === 0) return null;
  return (
    <ul className="ade-health-hbars" aria-label="Lanes by size">
      {bars.map((bar) => (
        <li key={bar.id} className="ade-health-hbar" title={`${bar.label} · ${formatMeasuredBytes(bar.bytes, bar.partial)}`}>
          <span className="ade-health-hbar-label">
            <span className="ade-health-hbar-name">{bar.label}</span>
            {bar.status && LANE_STATUS_TAG[bar.status] ? <span className="kit-tag">{LANE_STATUS_TAG[bar.status]}</span> : null}
          </span>
          <span className="ade-health-hbar-track" aria-hidden>
            <span style={{ width: `${Math.max(1, (bar.bytes / max) * 100)}%` }} data-other={bar.id === "other" || undefined} />
          </span>
          <span className="ade-health-hbar-value kit-num">{formatMeasuredBytes(bar.bytes, bar.partial)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * How full the disk is: a neutral meter of used space that turns amber at
 * 20% free and red at 5% (the Usage headroom rule).
 */
export function FreeSpaceMeter({
  freeBytes,
  totalBytes,
  level,
}: {
  freeBytes: number;
  totalBytes: number;
  level: "warn" | "crit" | undefined;
}) {
  // Every label beside this meter names free space ("68 GB free"), so the
  // fill is the free share: a short amber bar reads as "running out".
  const freePct = totalBytes > 0 ? Math.min(100, Math.max(0, (freeBytes / totalBytes) * 100)) : 0;
  return (
    <div
      className="kit-meter"
      data-level={level}
      role="meter"
      aria-label="Disk free"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(freePct)}
    >
      <span style={{ width: `${freePct}%` }} />
    </div>
  );
}

export type RunColumn = {
  key: string;
  label: string;
  files: number;
  database: number;
  history: number;
  total: number;
  failed: boolean;
};

const RUN_PARTS = [
  { key: "files", label: "Files", hue: SPLIT_COLORS.input },
  { key: "database", label: "Database", hue: SPLIT_COLORS.cacheWrite },
  { key: "history", label: "History", hue: SPLIT_COLORS.output },
] as const;

/**
 * Freed bytes per cleanup run, oldest left, as stacked columns (files,
 * database, history). A run that freed nothing draws a hairline, not a gap.
 */
export function CleanupRunChart({ runs }: { runs: RunColumn[] }) {
  const theme = useChartTheme();
  const [hovered, setHovered] = React.useState<string | null>(null);
  const max = Math.max(...runs.map((run) => run.total), 1);
  if (runs.length === 0) return null;
  const active = runs.find((run) => run.key === hovered) ?? runs[runs.length - 1]!;
  const present = RUN_PARTS.filter((part) => runs.some((run) => run[part.key] > 0));
  return (
    <div className="ade-health-runs">
      <div className="ade-health-runs-readout">
        <span className="kit-eyebrow">{active.label}</span>
        <span className="kit-num">{active.total > 0 ? `${formatBytes(active.total)} freed` : "Nothing to free"}</span>
      </div>
      <div
        className="ade-health-runs-plot"
        role="img"
        aria-label={`Space freed per cleanup: ${runs.map((run) => `${run.label} ${formatBytes(run.total)}`).join(", ")}`}
        onMouseLeave={() => setHovered(null)}
      >
        {runs.map((run) => (
          <span
            key={run.key}
            className="ade-health-runs-col"
            data-active={run.key === active.key || undefined}
            data-failed={run.failed || undefined}
            onMouseEnter={() => setHovered(run.key)}
            title={`${run.label} · ${formatBytes(run.total)}`}
          >
            {run.total > 0 ? (
              RUN_PARTS.map((part) => (run[part.key] > 0 ? (
                <i
                  key={part.key}
                  style={{ height: `${(run[part.key] / max) * 100}%`, background: part.hue[theme] }}
                />
              ) : null))
            ) : (
              <i className="ade-health-runs-zero" />
            )}
          </span>
        ))}
      </div>
      {present.length > 0 ? (
        <div className="ade-health-legend">
          {present.map((part) => (
            <span key={part.key} className="kit-legend">
              <i style={{ background: part.hue[theme] }} />
              {part.label}
              <b>{formatBytes(active[part.key])}</b>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type CompareBar = {
  id: string;
  label: string;
  value: number;
  /** Shown instead of the number, e.g. "≥ 3" or "—". */
  display?: string;
  tone?: "warn" | "crit";
};

/**
 * A few counts side by side as horizontal bars scaled to the largest, e.g.
 * slow against failed responses. A zero draws an empty track, not a gap.
 */
export function CompareBars({ bars, ariaLabel }: { bars: CompareBar[]; ariaLabel: string }) {
  const max = Math.max(...bars.map((bar) => bar.value), 1);
  return (
    <ul className="ade-health-hbars" aria-label={ariaLabel}>
      {bars.map((bar) => (
        <li key={bar.id} className="ade-health-hbar" data-compact="true">
          <span className="ade-health-hbar-label"><span className="ade-health-hbar-name">{bar.label}</span></span>
          <span className="ade-health-hbar-track" aria-hidden>
            {bar.value > 0 ? (
              <span
                style={{
                  width: `${Math.max(2, (bar.value / max) * 100)}%`,
                  background: bar.tone ? `var(--kit-${bar.tone})` : undefined,
                }}
              />
            ) : null}
          </span>
          <span className="ade-health-hbar-value kit-num">{bar.display ?? bar.value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * This computer's memory as one bar: the ADE service, everything else in use,
 * and what is free, with a legend that names each with its size.
 */
export function MemoryBar({
  serviceBytes,
  totalBytes,
  freeBytes,
}: {
  serviceBytes: number;
  totalBytes: number;
  freeBytes: number | null;
}) {
  const theme = useChartTheme();
  if (totalBytes <= 0) return null;
  const used = freeBytes != null ? Math.max(serviceBytes, totalBytes - freeBytes) : null;
  const other = used != null ? Math.max(0, used - serviceBytes) : null;
  const parts = [
    { id: "service", label: "ADE service", bytes: serviceBytes, color: SPLIT_COLORS.input[theme] },
    ...(other != null ? [{ id: "other", label: "Everything else", bytes: other, color: SPLIT_COLORS.neutral[theme] }] : []),
    ...(freeBytes != null ? [{ id: "free", label: "Free", bytes: Math.max(0, freeBytes), color: "var(--kit-track)" }] : []),
  ];
  return (
    <div className="usage-split" role="group" aria-label="Memory on this computer">
      <div
        className="usage-split-bar ade-health-bar"
        role="img"
        aria-label={parts.map((part) => `${part.label} ${formatBytes(part.bytes)}`).join(", ")}
      >
        {parts.map((part) => (
          <span
            key={part.id}
            style={{ flexGrow: Math.max(part.bytes, totalBytes * 0.006), flexBasis: 0, background: part.color }}
            title={`${part.label} · ${formatBytes(part.bytes)}`}
          />
        ))}
      </div>
      <div className="usage-split-legend">
        {parts.map((part) => (
          <span key={part.id} className="usage-split-legend-item">
            <i aria-hidden style={{ background: part.color }} />
            {part.label}
            <b>{formatBytes(part.bytes)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * A count split into parts as one thin stacked bar with a legend, e.g. lanes
 * that are active, stale and with changes. Colours mean status: neutral for
 * fine, amber for stale, the accent for work in progress.
 */
export function CountBar({
  parts,
  ariaLabel,
  height,
}: {
  parts: Array<{ id: string; label: string; count: number; color: string }>;
  ariaLabel: string;
  height?: number;
}) {
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  if (total <= 0) return null;
  const shown = parts.filter((part) => part.count > 0);
  return (
    <div
      className="usage-split-bar ade-health-bar"
      role="img"
      aria-label={`${ariaLabel}: ${shown.map((part) => `${part.count} ${part.label.toLowerCase()}`).join(", ")}`}
      style={height ? { height } : undefined}
    >
      {shown.map((part) => (
        <span key={part.id} style={{ flexGrow: part.count, flexBasis: 0, background: part.color }} title={`${part.count} ${part.label.toLowerCase()}`} />
      ))}
    </div>
  );
}
