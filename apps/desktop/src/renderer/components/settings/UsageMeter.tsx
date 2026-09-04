import { useMemo } from "react";
import { cn } from "../ui/cn";
import { usePluginThemeRevision } from "../../lib/usePluginThemeRevision";
import { chartSeriesColor } from "../usage/providerColors";
import { useAppStore } from "../../state/appStore";

export function UsageMeter({
  label,
  percent,
  sublabel,
  modelBreakdown,
  mode = "used",
  toneColor = "#A78BFA",
  className,
}: {
  label: string;
  percent: number;
  sublabel?: string;
  modelBreakdown?: Record<string, number>;
  mode?: "used" | "remaining";
  toneColor?: string;
  className?: string;
}) {
  const theme = useAppStore((s) => s.theme);
  const pluginThemeRevision = usePluginThemeRevision();
  const clamped = Math.max(0, Math.min(100, percent));
  const breakdownEntries = modelBreakdown ? Object.entries(modelBreakdown) : [];
  const hasBreakdown = breakdownEntries.length > 0;
  // Resolved to literals, not `var()` strings: the dedupe below compares this
  // palette against `toneColor` (a resolved provider colour), and two different
  // `var()` names never compare equal even when they paint the same pixel.
  const modelColors = useMemo(
    () => MODEL_SERIES_INDEXES.map((index) => chartSeriesColor(index, theme)),
    // The revision is a cache-buster, not a value the callback reads; dropping
    // it leaves the legend on the previous plugin theme's series palette.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, pluginThemeRevision],
  );
  const modelPalette = modelColors.filter((color) => color.toLowerCase() !== toneColor.toLowerCase());
  const modelColor = (index: number) => {
    if (index === 0) return toneColor;
    return modelPalette[(index - 1) % modelPalette.length] ?? toneColor;
  };
  let cumulativeBreakdownPct = 0;
  const breakdownMarkers = breakdownEntries.map(([model, pct], i) => {
    const subClamped = Math.max(0, Math.min(100, pct));
    if (subClamped <= 0) return null;
    cumulativeBreakdownPct = Math.min(100, cumulativeBreakdownPct + subClamped);
    return {
      model,
      left: Math.min(99, cumulativeBreakdownPct),
      color: modelColor(i),
    };
  });
  const fillColor =
    mode === "remaining"
      ? clamped <= 10
        ? "#EF4444"
        : clamped <= 30
          ? "#F59E0B"
          : "#22C55E"
      : clamped > 90
        ? "#EF4444"
        : clamped > 70
          ? "#F59E0B"
          : toneColor;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
          {label}
        </span>
        <span className="font-mono text-[10px] font-bold text-[#FAFAFA]">
          {clamped.toFixed(1)}% {mode}
        </span>
      </div>

      <div
        className="relative h-2 w-full overflow-hidden rounded-sm"
        style={{ background: "#1A1720", border: "1px solid #1E1B26" }}
        role="progressbar"
        aria-label={`${label}: ${clamped.toFixed(1)}% ${mode}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
      >
        <div
          className="absolute inset-y-0 left-0 transition-all duration-500 ease-out"
          style={{
            width: `${clamped}%`,
            background: fillColor,
          }}
        />
        {hasBreakdown
          ? breakdownMarkers.map((marker) => {
              if (!marker) return null;
              return (
                <span
                  key={`tick-${marker.model}`}
                  className="absolute top-0 bottom-0 w-px"
                  style={{
                    left: `${marker.left}%`,
                    background: marker.color,
                    opacity: 0.85,
                  }}
                  aria-hidden
                />
              );
            })
          : null}
      </div>

      {sublabel && (
        <div className="font-mono text-[9px] text-[#71717A]">{sublabel}</div>
      )}

      {hasBreakdown && (
        <div className="flex flex-wrap gap-3 pt-0.5">
          {breakdownEntries.map(([model, pct], i) => (
            <div key={model} className="flex items-center gap-1.5">
              <div
                className="h-1.5 w-1.5"
                style={{ background: modelColor(i) }}
              />
              <span className="font-mono text-[9px] text-[#8B8B9A]">
                {model} {pct.toFixed(1)}% {mode}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The per-model segments of the meter are a data series, so they now ride the
 * app's series palette (`--color-chart-1..6`) instead of the six ad-hoc hexes
 * this file used to carry. Those hexes were dark-theme values with no light
 * counterpart, which is exactly the bug: on the light theme the legend swatches
 * were tuned for a surface they never sat on, and no theme could touch them.
 *
 * Indexes, not colours — `chartSeriesColor` maps 0..5 onto `--color-chart-1..6`
 * and resolves each against the live document.
 */
const MODEL_SERIES_INDEXES = [0, 1, 2, 3, 4, 5];
