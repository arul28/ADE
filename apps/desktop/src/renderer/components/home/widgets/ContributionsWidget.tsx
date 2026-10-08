import { useEffect, useMemo, useRef, useState } from "react";
import { Cube, GridFour, SquaresFour } from "@phosphor-icons/react";
import type { AdeUsageDailyPoint } from "../../../../shared/types";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { openUsageDetails } from "../../projects/ProjectWelcomeSidePanels";
import { ActivityHeatmap, computeHeatmapLayout, useHeatmapCells, weekAlignment } from "../../usage/ActivityHeatmap";
import { formatCompact } from "../../../lib/format";
import { dayHasActivity, scoreActivityDays } from "../../usage/activityIntensity";
import { useHomeData } from "../homeData";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetSpan } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../homeWidgets.css";

/**
 * Your work in ADE as a contribution skyline: each day a tower (chats,
 * commits and PRs that day), weeks running back along an isometric street,
 * with the year's total, busiest day and streaks beside it. A flat calendar
 * view is one click away. From the usage stats the home page already loaded
 * (this machine, all time); no reads of its own.
 */

function parseDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d);
}

function dayLabel(date: string, withWeekday = true): string {
  return parseDay(date).toLocaleDateString(undefined, withWeekday ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
}

function describe(point: AdeUsageDailyPoint): string {
  const parts = [
    point.sessions > 0 ? `${point.sessions} chat${point.sessions === 1 ? "" : "s"}` : null,
    point.commits > 0 ? `${point.commits} commit${point.commits === 1 ? "" : "s"}` : null,
    point.prs > 0 ? `${point.prs} PR${point.prs === 1 ? "" : "s"}` : null,
    point.totalTokens > 0 ? `${formatCompact(point.totalTokens)} tokens` : null,
  ].filter(Boolean);
  return `${dayLabel(point.date)} · ${parts.length > 0 ? parts.join(" · ") : "No activity"}`;
}

type Streak = { days: number; from: string | null; to: string | null };

function streaks(days: readonly AdeUsageDailyPoint[]): { longest: Streak; current: Streak } {
  let longest: Streak = { days: 0, from: null, to: null };
  let run: Streak = { days: 0, from: null, to: null };
  for (const point of days) {
    if (dayHasActivity(point)) {
      run = { days: run.days + 1, from: run.from ?? point.date, to: point.date };
      if (run.days > longest.days) longest = run;
    } else {
      run = { days: 0, from: null, to: null };
    }
  }
  // A streak is still current when today has nothing yet but yesterday did.
  const last = days.at(-1);
  const current = last && !dayHasActivity(last) && days.length > 1 && dayHasActivity(days.at(-2)!)
    ? (() => {
        let count = 0;
        let from: string | null = null;
        for (let index = days.length - 2; index >= 0 && dayHasActivity(days[index]!); index -= 1) {
          count += 1;
          from = days[index]!.date;
        }
        return { days: count, from, to: days.at(-2)!.date };
      })()
    : run;
  return { longest, current };
}

const COS30 = Math.cos(Math.PI / 6);

type Tower = { key: string; point: AdeUsageDailyPoint; value: number; level: number; col: number; row: number; today: boolean };
type SkyDay = { point: AdeUsageDailyPoint; level: number; score: number };

/** The isometric street: weeks run along it, weekdays across it, towers rise by count. */
function Skyline({ days, width, height, onHover }: { days: readonly SkyDay[]; width: number; height: number; onHover: (point: AdeUsageDailyPoint | null) => void }) {
  const layout = useMemo(() => {
    if (width < 40 || height < 40 || days.length === 0) return null;
    const maxTower = Math.min(height * 0.4, 70);
    // As many whole weeks as fit both ways at a readable tile size.
    const maxWeeks = Math.max(4, Math.min(53, Math.floor((2 * width) / (COS30 * 12)) - 7, Math.floor((4 * (height - maxTower)) / 12) - 7));
    const lastWeekday = (parseDay(days.at(-1)!.point.date).getDay() + 6) % 7; // Monday = 0
    const weekCount = Math.min(maxWeeks, Math.ceil((days.length - lastWeekday - 1) / 7) + 1);
    const shown = days.slice(-((weekCount - 1) * 7 + lastWeekday + 1));
    const lead = (parseDay(shown[0]!.point.date).getDay() + 6) % 7;
    const max = Math.max(1e-9, ...shown.map((day) => day.score));
    const towers: Tower[] = shown.map((day, index) => ({
      key: day.point.date,
      point: day.point,
      value: day.level === 0 ? 0 : day.score,
      level: day.level,
      col: Math.floor((index + lead) / 7),
      row: (index + lead) % 7,
      today: index === shown.length - 1,
    }));
    // Tile size: the street (weeks + 7 weekday rows, at 30°) must fit both ways.
    const diagonal = weekCount + 7;
    // Neighbouring tiles touch at half a tile's width across and a quarter down.
    const tile = Math.max(6, Math.min(30, (2 * (width - 8)) / (diagonal * COS30), (4 * (height - maxTower - 8)) / diagonal));
    const towerHeight = (value: number) => (value === 0 ? 1.2 : 3 + (maxTower - 3) * Math.sqrt(value / max));
    const halfX = tile * COS30 * 0.5;
    const halfY = tile * 0.25;
    const streetWidth = (diagonal + 1) * halfX;
    const streetHeight = (diagonal + 1) * halfY;
    const originX = (width - streetWidth) / 2 + 7 * halfX;
    const originY = (height - streetHeight - maxTower) / 2 + maxTower + halfY;
    return { towers: [...towers].sort((a, b) => a.col + a.row - (b.col + b.row) || a.col - b.col), tile, towerHeight, originX, originY };
  }, [days, height, width]);
  if (!layout) return null;
  const { towers, tile, towerHeight, originX, originY } = layout;
  const hx = tile * COS30 * 0.5;
  const hy = tile * 0.25;
  return (
    <svg className="ade-skyline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily activity as a skyline" onMouseLeave={() => onHover(null)}>
      {towers.map((tower, index) => {
        // Centre of the tile's top face at ground level.
        const cx = originX + (tower.col - tower.row) * hx;
        const cy = originY + (tower.col + tower.row) * hy;
        const h = towerHeight(tower.value);
        const top = `${cx},${cy - h - hy} ${cx + hx},${cy - h} ${cx},${cy - h + hy} ${cx - hx},${cy - h}`;
        const left = `${cx - hx},${cy - h} ${cx},${cy - h + hy} ${cx},${cy + hy} ${cx - hx},${cy}`;
        const right = `${cx + hx},${cy - h} ${cx},${cy - h + hy} ${cx},${cy + hy} ${cx + hx},${cy}`;
        return (
          <g
            key={tower.key}
            className="ade-skyline-tower"
            data-l={tower.level}
            data-today={tower.today || undefined}
            style={{ animationDelay: `${Math.min(600, index * 2)}ms` }}
            onMouseEnter={() => onHover(tower.point)}
          >
            <polygon className="ade-skyline-left" points={left} />
            <polygon className="ade-skyline-right" points={right} />
            <polygon className="ade-skyline-top" points={top} />
          </g>
        );
      })}
    </svg>
  );
}

export default function ContributionsWidget({ item }: HomeWidgetProps) {
  const { stats } = useHomeData();
  const updateSettings = useHomeLayoutStore((s) => s.updateSettings);
  const span = useWidgetSpan(item);
  const view = item.settings?.view === "grid" ? "grid" : "skyline";
  const daily = stats && stats !== "unavailable" ? stats.daily : null;
  const lastYear = useMemo(() => (daily ? daily.slice(-371) : []), [daily]);
  const cells = useHeatmapCells(lastYear);
  const days = useMemo(() => cells.map((cell) => cell.point), [cells]);
  const skyDays = useMemo((): SkyDay[] => {
    const scores = scoreActivityDays(days);
    return cells.map((cell, index) => ({ point: cell.point, level: cell.level, score: scores[index] ?? 0 }));
  }, [cells, days]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<AdeUsageDailyPoint | null>(null);
  useEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setBox({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [cells.length]);

  const facts = useMemo(() => {
    const activeDays = days.filter(dayHasActivity).length;
    const busiest = skyDays.reduce<SkyDay | null>((best, day) => (!best || day.score > best.score ? day : best), null)?.point ?? null;
    return { activeDays, busiest, ...streaks(days) };
  }, [days, skyDays]);

  const align = weekAlignment(cells);
  const maxCell = Math.max(6, Math.min(16, Math.floor((box.height - 6 * 3) / 7)));
  const gridLayout = useMemo(
    () => computeHeatmapLayout({ cellCount: cells.length, maxCell, availableWidth: box.width, leading: align.leading, trailing: align.trailing }),
    [align.leading, align.trailing, box.width, cells.length, maxCell],
  );
  const showSide = span.w >= 2 || span.h >= 2;
  const range = days.length > 0 ? `${dayLabel(days[0]!.date, false)} – ${dayLabel(days.at(-1)!.date, false)}` : null;

  return (
    <section className="kit-card ade-home-card ade-contrib" aria-label="Contributions" data-size={item.size}>
      <WelcomeCardHead icon={SquaresFour} title="Contributions" action={{ label: "Details", onClick: openUsageDetails }}>
        <span className="ade-home-card-scope">this machine</span>
        <div className="kit-seg ade-contrib-view" role="radiogroup" aria-label="View">
          <button type="button" role="radio" aria-checked={view === "skyline"} title="Skyline" aria-label="Skyline" onClick={() => updateSettings(item.id, { view: "skyline" })}>
            <Cube size={12} />
          </button>
          <button type="button" role="radio" aria-checked={view === "grid"} title="Calendar" aria-label="Calendar" onClick={() => updateSettings(item.id, { view: "grid" })}>
            <GridFour size={12} />
          </button>
        </div>
      </WelcomeCardHead>
      <div className="kit-card-body ade-contrib-body" data-side={showSide || undefined}>
        {stats === "unavailable" ? (
          <div className="ade-home-empty"><span>Activity history is unavailable here.</span></div>
        ) : !stats ? (
          <div className="ade-home-empty"><span>Reading your activity…</span></div>
        ) : cells.length === 0 ? (
          <div className="ade-home-empty">
            <SquaresFour size={18} aria-hidden />
            <span>Your first chat starts the map.</span>
          </div>
        ) : (
          <>
            <dl className="ade-contrib-stats">
              <div className="ade-contrib-stat ade-contrib-stat-lead">
                <dt className="kit-eyebrow">{range ?? "This year"}</dt>
                <dd><span className="ade-contrib-figure kit-num">{facts.activeDays}</span><span className="ade-contrib-unit">active days</span></dd>
              </div>
              <div className="ade-contrib-stat">
                <dt className="kit-eyebrow">Busiest day</dt>
                <dd>
                  <span className="ade-contrib-figure kit-num">{facts.busiest ? dayLabel(facts.busiest.date, false) : "—"}</span>
                  <span className="ade-contrib-unit">{facts.busiest ? `${formatCompact(facts.busiest.totalTokens)} tokens` : ""}</span>
                </dd>
              </div>
              <div className="ade-contrib-stat">
                <dt className="kit-eyebrow">Longest streak</dt>
                <dd><span className="ade-contrib-figure kit-num">{facts.longest.days}</span><span className="ade-contrib-unit">{facts.longest.days === 1 ? "day" : "days"}</span></dd>
              </div>
              <div className="ade-contrib-stat">
                <dt className="kit-eyebrow">Current streak</dt>
                <dd><span className="ade-contrib-figure kit-num" data-live={facts.current.days > 0 || undefined}>{facts.current.days}</span><span className="ade-contrib-unit">{facts.current.days === 1 ? "day" : "days"}</span></dd>
              </div>
            </dl>
            <div className="ade-contrib-stage">
              <div ref={hostRef} className="ade-contrib-map">
                {box.width > 0 ? (
                  view === "skyline" ? (
                    <Skyline days={skyDays} width={box.width} height={box.height} onHover={setHover} />
                  ) : (
                    <ActivityHeatmap
                      cells={cells}
                      layout={gridLayout}
                      reduced
                      showKey={false}
                      tooltip={{
                        show: (point) => setHover(point),
                        hide: () => setHover(null),
                        toggle: (point) => setHover((current) => (current?.date === point.date ? null : point)),
                      }}
                    />
                  )
                ) : null}
              </div>
              <div className="ade-contrib-foot">
                <span className="ade-contrib-readout kit-num" aria-live="polite">{hover ? describe(hover) : "Chats, commits, PRs and tokens per day"}</span>
                <span className="ade-contrib-key" aria-hidden>
                  Less
                  {[0, 1, 2, 3, 4].map((level) => <i key={level} data-l={level} />)}
                  More
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
