import { useMemo } from "react";
import type { AdeUsageDailyPoint } from "../../../shared/types";
import { usePrefersMoreContrast } from "../../hooks/usePrefersMoreContrast";
import { type ThemeId, useAppStore } from "../../state/appStore";
import {
  type ActivityLevel,
  bucketActivityIntensity,
  scoreActivityDays,
  trimLeadingInactiveDays,
} from "./activityIntensity";
import { USAGE_TEXT } from "./usageDesign";
import { cn } from "../ui/cn";

const HEATMAP_GAP = 3;
const HEATMAP_MIN_CELL = 6;

/**
 * The intensity ramp, as light/dark pairs in the same shape `providerColors.ts`
 * uses — the one place in this module allowed to name colours, because a
 * sequential scale is a scale, not a theme token.
 *
 * Why pairs and not one hue at five opacities: an opacity ramp of a single hue
 * (what this was) is only a lightness ramp, and a lightness ramp against a card
 * of nearly the same lightness reads as five greys — a busy day looked like a
 * slightly darker quiet day. This ramp moves along two channels at once: hue
 * turns cool → warm, and contrast against the card rises at every step. Either
 * channel alone is enough to order the levels, so the scale still reads in
 * greyscale, with colour-vision deficiency, and on a forced-contrast display.
 *
 * Contrast ratios against their own card (dark #1E1B2E / light #FFFFFF):
 *   dark  2.0 → 3.4 → 4.7 → 7.9      light 1.6 → 2.6 → 3.7 → 6.0
 * Monotonic in both themes, which is why the top step is a bright orange on
 * dark and a deep brick on light: "hot" has to mean luminous on a dark card and
 * dense on a white one. Saturation climbs with the level too, so the low half
 * stays near-neutral and recedes — this module sits above the composer and must
 * not compete with it, and only the busy days should carry colour.
 *
 * Nothing here borrows `--color-accent`: it is violet in dark and green in
 * light, so a ramp built on it would swap hue families between themes and land
 * on exactly the generic violet this product avoids.
 */
type RampPair = { light: string; dark: string };

const HEATMAP_RAMP: Record<Exclude<ActivityLevel, 0>, RampPair> = {
  // desaturated slate — quiet, but unmistakably "something happened"
  1: { light: "#BCCEDA", dark: "#3A4E63" },
  // teal — the midpoint, still cool
  2: { light: "#79ABA5", dark: "#2F7A80" },
  // ember — the turn to warm
  3: { light: "#C96C1E", dark: "#DE6039" },
  // the top quartile, and the only tone allowed to shout
  4: { light: "#B23A20", dark: "#FF9A3D" },
};

/** Empty day: structure, not damage — a visible tile, not a hole in the card. */
const HEATMAP_EMPTY_BG = "color-mix(in srgb, var(--color-fg) 7%, transparent)";
const HEATMAP_EMPTY_EDGE = "inset 0 0 0 1px color-mix(in srgb, var(--color-fg) 5%, transparent)";
/** Ring drawn just outside today's cell, into the 3px gutter. */
const HEATMAP_TODAY_RING = "0 0 0 1.5px color-mix(in srgb, var(--color-fg) 45%, transparent)";
/** Forced-contrast displays get a hairline on every tile so steps stay crisp. */
const HEATMAP_CONTRAST_EDGE = "inset 0 0 0 1px color-mix(in srgb, var(--color-fg) 26%, transparent)";

export type HeatmapLayout = {
  rows: number;
  cols: number;
  cell: number;
  width: number;
  visible: number;
};

/**
 * `leading`/`trailing` are the empty slots the calendar itself demands: the
 * weekdays before the first day in view and after the last one. They are part
 * of the grid's footprint even though no cell is drawn in them, so the column
 * count has to include them or the last week spills past the measured width.
 * Both default to 0, which is also what a single-row strip uses.
 */
export function computeHeatmapLayout({
  cellCount,
  maxCell,
  availableWidth,
  leading = 0,
  trailing = 0,
}: {
  cellCount: number;
  maxCell: number;
  availableWidth: number;
  leading?: number;
  trailing?: number;
}): HeatmapLayout {
  if (cellCount <= 0) return { rows: 1, cols: 0, cell: maxCell, width: 0, visible: 0 };

  const rows = cellCount <= 7 ? 1 : 7;
  // A strip of seven or fewer days is a strip, not a calendar: aligning it to
  // weekdays would push a five-day range into two columns for no gain.
  const pad = rows === 1 ? { leading: 0, trailing: 0 } : { leading, trailing };
  const slots = cellCount + pad.leading + pad.trailing;
  const cols = Math.max(1, Math.ceil(slots / rows));
  const spanOf = (columns: number, cell: number) => columns * cell + (columns - 1) * HEATMAP_GAP;

  if (availableWidth <= 0) {
    return { rows, cols, cell: maxCell, width: spanOf(cols, maxCell), visible: cellCount };
  }

  const fitted = Math.floor((availableWidth - (cols - 1) * HEATMAP_GAP) / cols);
  const cell = Math.max(HEATMAP_MIN_CELL, Math.min(maxCell, fitted));
  if (spanOf(cols, cell) <= availableWidth) {
    return { rows, cols, cell, width: spanOf(cols, cell), visible: cellCount };
  }

  const visibleCols = Math.max(1, Math.floor((availableWidth + HEATMAP_GAP) / (cell + HEATMAP_GAP)));
  // Dropping whole weeks from the front is what keeps the surviving tail on its
  // real weekday rows: subtracting the trailing pad makes the kept run end
  // exactly where it does now and start on the first row of a column.
  const capacity = visibleCols * rows - pad.trailing;
  return {
    rows,
    cols: visibleCols,
    cell,
    width: spanOf(visibleCols, cell),
    visible: Math.max(1, Math.min(cellCount, capacity)),
  };
}

type HeatmapCell = { point: AdeUsageDailyPoint; level: ActivityLevel };

const MS_PER_DAY = 86_400_000;
/** Ten years of gap-filled days; past this the grid cannot show them anyway. */
const HEATMAP_MAX_DAYS = 3_700;

function parseDayKey(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function dayKeyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0 = Sunday, matching the first row of the grid. */
function weekdayOfDayKey(date: string): number {
  const parsed = parseDayKey(date);
  return Number.isFinite(parsed) ? new Date(parsed).getUTCDay() : 0;
}

function emptyDay(date: string): AdeUsageDailyPoint {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    commits: 0,
    prs: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
    sessions: 0,
    interactions: 0,
  };
}

/**
 * Makes the series date-complete, so position in the grid means date.
 *
 * The daily series is not guaranteed gap-free: on the `year` and `all` presets
 * the host emits a bounded skeleton and then appends a point for every other
 * date its ledger scan happened to see, which sorts in ahead of the skeleton.
 * Laid out by array index, two dates a month apart ended up adjacent cells, and
 * every weekday row below them was off by the size of the gap. Filling the gaps
 * with real zero-days fixes both at once, and a missing day genuinely *is* a
 * zero day — it is not invented data.
 */
export function fillMissingDays(points: readonly AdeUsageDailyPoint[]): AdeUsageDailyPoint[] {
  if (points.length < 2) return [...points];
  const filled: AdeUsageDailyPoint[] = [];
  for (const point of points) {
    const previous = filled.at(-1);
    const currentMs = parseDayKey(point.date);
    const previousMs = previous ? parseDayKey(previous.date) : Number.NaN;
    if (previous && Number.isFinite(currentMs) && Number.isFinite(previousMs)) {
      for (let ms = previousMs + MS_PER_DAY; ms < currentMs; ms += MS_PER_DAY) {
        filled.push(emptyDay(dayKeyFromMs(ms)));
        if (filled.length > HEATMAP_MAX_DAYS * 2) break;
      }
    }
    filled.push(point);
  }
  return filled.length > HEATMAP_MAX_DAYS ? filled.slice(filled.length - HEATMAP_MAX_DAYS) : filled;
}

/** Empty weekday slots the calendar needs before the first and after the last day. */
export function weekAlignment(cells: readonly HeatmapCell[]): { leading: number; trailing: number } {
  const first = cells[0]?.point.date;
  const last = cells.at(-1)?.point.date;
  if (!first || !last) return { leading: 0, trailing: 0 };
  return { leading: weekdayOfDayKey(first), trailing: 6 - weekdayOfDayKey(last) };
}

export function useHeatmapCells(points: AdeUsageDailyPoint[]): HeatmapCell[] {
  return useMemo(() => {
    const ordered = fillMissingDays(
      trimLeadingInactiveDays([...points].sort((a, b) => a.date.localeCompare(b.date))),
    );
    const levels = bucketActivityIntensity(scoreActivityDays(ordered));
    return ordered.map((point, index) => ({ point, level: levels[index] ?? 0 }));
  }, [points]);
}

/** Local calendar day as `YYYY-MM-DD`, matching the daily-point key format. */
export function localDayKey(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type LevelStyles = {
  cell: Record<ActivityLevel, React.CSSProperties>;
  today: Record<ActivityLevel, React.CSSProperties>;
};

/**
 * Ten style objects — one per level, plus a today-ringed variant — built once
 * per theme/contrast/motion combination. Cells then reuse a shared object
 * reference, so rendering a 365-day grid allocates nothing per cell and holds
 * no per-cell state.
 */
function useLevelStyles(theme: ThemeId, contrast: boolean, reduced: boolean): LevelStyles {
  return useMemo(() => {
    const transition = reduced ? undefined : "background 120ms ease";
    const cell = {} as Record<ActivityLevel, React.CSSProperties>;
    const today = {} as Record<ActivityLevel, React.CSSProperties>;
    for (const level of [0, 1, 2, 3, 4] as const) {
      const background = level === 0 ? HEATMAP_EMPTY_BG : HEATMAP_RAMP[level][theme];
      const edge = contrast ? HEATMAP_CONTRAST_EDGE : level === 0 ? HEATMAP_EMPTY_EDGE : null;
      cell[level] = { background, transition, cursor: "default", ...(edge ? { boxShadow: edge } : null) };
      today[level] = {
        background,
        transition,
        cursor: "default",
        boxShadow: edge ? `${edge}, ${HEATMAP_TODAY_RING}` : HEATMAP_TODAY_RING,
      };
    }
    return { cell, today };
  }, [theme, contrast, reduced]);
}

type HeatmapTooltip = {
  show: (point: AdeUsageDailyPoint, target: HTMLElement) => void;
  hide: () => void;
  toggle: (point: AdeUsageDailyPoint, target: HTMLElement) => void;
};

/** "Less → More" key, so the ramp explains itself instead of being decoded. */
function RampKey({ styles }: { styles: Record<ActivityLevel, React.CSSProperties> }) {
  return (
    <div className={cn("flex items-center gap-1 text-muted-fg", USAGE_TEXT.micro)} aria-hidden="true">
      <span>Less</span>
      {([0, 1, 2, 3, 4] as const).map((level) => (
        <span key={level} className="h-2 w-2 rounded-[2px]" style={{ background: styles[level].background }} />
      ))}
      <span>More</span>
    </div>
  );
}

export function ActivityHeatmap({
  cells,
  layout,
  reduced,
  tooltip,
}: {
  cells: HeatmapCell[];
  layout: HeatmapLayout;
  reduced: boolean;
  tooltip: HeatmapTooltip;
}) {
  const theme = useAppStore((state) => state.theme);
  const contrast = usePrefersMoreContrast();
  const levelStyles = useLevelStyles(theme, contrast, reduced);
  const { rows, cell } = layout;
  const shown = layout.visible >= cells.length ? cells : cells.slice(cells.length - layout.visible);
  const today = localDayKey();
  // Starting the first cell on its own weekday row is what makes a column mean
  // "one calendar week" — without it the rows are seven arbitrary bands whose
  // meaning shifts every time the first day in view changes.
  const rowStart = rows === 7 && shown[0] ? weekdayOfDayKey(shown[0].point.date) + 1 : 1;

  return (
    <div className="flex w-full flex-col items-center gap-1.5">
      <div
        className="grid"
        style={{
          gap: HEATMAP_GAP,
          width: layout.width,
          height: rows * cell + (rows - 1) * HEATMAP_GAP,
          gridAutoFlow: "column",
          gridTemplateRows: `repeat(${rows}, ${cell}px)`,
          gridAutoColumns: `${cell}px`,
        }}
        role="img"
        aria-label="Daily activity heatmap"
        data-heatmap-rows={rows}
        data-heatmap-cell={cell}
      >
        {shown.map(({ point, level }, index) => {
          const isToday = point.date === today;
          const base = isToday ? levelStyles.today[level] : levelStyles.cell[level];
          return (
            <span
              key={point.date}
              className="rounded-[2px]"
              data-level={level}
              data-today={isToday ? "true" : undefined}
              style={index === 0 && rowStart > 1 ? { ...base, gridRowStart: rowStart } : base}
              onPointerEnter={(event) => tooltip.show(point, event.currentTarget)}
              onPointerLeave={tooltip.hide}
              onClick={(event) => tooltip.toggle(point, event.currentTarget)}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-end" style={{ width: layout.width || undefined }}>
        <RampKey styles={levelStyles.cell} />
      </div>
    </div>
  );
}
