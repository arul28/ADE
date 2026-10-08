/*
 * Ported from the "contribution-skyline" component on 21st.dev.
 * Copyright (c) Kedhareswer Naidu. Used under the MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 *
 * Changed for ADE: theme tokens, sizing, the pure maths moved to
 * contributionSkylineModel.ts and the canvas loop to
 * contributionSkylineRender.ts. Listed in the repository NOTICE.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Cube, GridFour } from "@phosphor-icons/react";
import { cn } from "./cn";
import "./contributionSkyline.css";
import {
  buildGrid,
  computeStats,
  DAY_MS,
  dayMs,
  monthLabels,
  type ContributionDay,
} from "./contributionSkylineModel";
import { startSkylineRender, type SkylineEngine } from "./contributionSkylineRender";
export type { ContributionDay, ContributionStats, SkylineCell, SkylineStreak } from "./contributionSkylineModel";

/**
 * Contribution Skyline: a stretch of daily activity as a heat map that folds
 * up into an isometric skyline, and back down again. Ported from a 21st.dev
 * component the user picked, themed with ADE's tokens and made to fit any
 * box it is given (a home widget, a card section).
 *
 * It is one scene, not two charts. Every day is a box on a grid; the flat
 * view is that grid seen straight down, the 3D view is the same grid seen
 * from the corner. Switching views swings one camera between the two while
 * each week's bars rise (or settle) in a wave from the oldest week to the
 * newest, so the heat map visibly becomes the skyline.
 *
 * Hover or tap a day for its numbers, arrow keys walk the grid, hover a
 * legend swatch to isolate that level, and in 3D drag to orbit (double-click
 * resets). Theme changes blend rather than flip; reduced motion snaps.
 *
 * Sizing: it fills its parent. The stats, legend and hint come and go with
 * the room it has, and the number of weeks shown follows the width, so it
 * never overflows and never scrolls.
 *
 * Cost: canvas, drawn only while something moves (a morph, an orbit, a hover
 * easing, a colour blend). Idle, it draws nothing. `paused` (off screen, a
 * hidden window) stops the loop outright.
 */


type View = "2d" | "3d";

/** The flat ⇄ 3D switch, in the kit's segmented style; a host can put it in its own header. */
export function ContributionSkylineToggle({ view, onChange, className }: { view: View; onChange: (view: View) => void; className?: string }) {
  return (
    <div className={cn("kit-seg ade-skyline-toggle", className)} role="radiogroup" aria-label="Chart view">
      <button type="button" role="radio" aria-checked={view === "2d"} title="Heat map" aria-label="Flat heat map" onClick={() => onChange("2d")}>
        <GridFour size={12} />
      </button>
      <button type="button" role="radio" aria-checked={view === "3d"} title="3D skyline" aria-label="3D skyline" onClick={() => onChange("3d")}>
        <Cube size={12} />
      </button>
    </div>
  );
}

type StatBlock = { label: string; short: string; value: string; unit: string; sub: string };

function CornerStat({ block, size, align }: { block: StatBlock; size: number; align: "start" | "end" }) {
  return (
    <div className="ade-skyline-corner-stat" data-align={align}>
      <span className="ade-skyline-corner-label">{block.label}</span>
      <span className="ade-skyline-corner-value">
        <b className="kit-num" style={{ fontSize: size }}>{block.value}</b>
        <span>
          <span className="ade-skyline-corner-unit">{block.unit}</span>
          <span className="ade-skyline-corner-sub">{block.sub}</span>
        </span>
      </span>
    </div>
  );
}

export interface ContributionSkylineProps {
  /** One entry per day, `YYYY-MM-DD`. Repeated dates add up. */
  data: readonly ContributionDay[];
  /** Last day shown. Defaults to the latest date in `data`, or today. */
  endDate?: string | Date;
  /** Controlled view. */
  view?: View;
  /** Uncontrolled starting view. The 3D view rises out of the flat one when it first comes into sight. */
  defaultView?: View;
  onViewChange?: (view: View) => void;
  /** Singular noun for a unit of activity. */
  unit?: string;
  /** Plural noun. Defaults to `unit + "s"`. */
  unitPlural?: string;
  /** Formats a count (tokens read better as 1.2M). */
  formatCount?: (count: number) => string;
  /** Multiplies bar heights in 3D. */
  heightScale?: number;
  /** Morph length, ms. */
  duration?: number;
  /** 0 puts Sunday on the top row, 1 puts Monday there. */
  weekStart?: 0 | 1;
  /** Most weeks shown; fewer when the box is narrow. */
  maxWeeks?: number;
  /** Drag to orbit in 3D. */
  orbit?: boolean;
  showStats?: boolean;
  showLegend?: boolean;
  /** The view switch above the chart; off when the host puts one in its own header. */
  showToggle?: boolean;
  /** Stops drawing (off screen, a hidden window). */
  paused?: boolean;
  locale?: string;
  onCellClick?: (day: ContributionDay) => void;
  className?: string;
  /** Shown above the chart, beside the toggle. */
  title?: ReactNode;
}

export default function ContributionSkyline({
  data,
  endDate,
  view: viewProp,
  defaultView = "3d",
  onViewChange,
  unit = "contribution",
  unitPlural,
  formatCount,
  heightScale = 1,
  duration = 1300,
  weekStart = 1,
  maxWeeks = 53,
  orbit = true,
  showStats = true,
  showLegend = true,
  showToggle = true,
  paused = false,
  locale,
  onCellClick,
  className,
  title,
}: ContributionSkylineProps) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [stageBox, setStageBox] = useState({ width: 0, height: 0 });
  // Weeks follow the stage's width: a column narrower than ~10px stops reading as a day.
  const weeks = Math.max(8, Math.min(maxWeeks, stageBox.width > 0 ? Math.floor((stageBox.width - 8) / 11) : maxWeeks));
  const endKey = endDate == null ? null : dayMs(endDate);
  const model = useMemo(() => {
    const dates = data.map((d) => dayMs(d.date)).filter(Number.isFinite);
    const end = endKey ?? (dates.length ? Math.max(...dates, dayMs(new Date())) : dayMs(new Date()));
    const grid = buildGrid(data, end, weeks, weekStart);
    return { ...grid, stats: computeStats(grid.cells), months: monthLabels(grid.cells, grid.weeks, locale) };
  }, [data, endKey, weekStart, locale, weeks]);

  const [innerView, setInnerView] = useState<View>(defaultView);
  const view = viewProp ?? innerView;
  const setView = (v: View) => {
    if (viewProp === undefined) setInnerView(v);
    onViewChange?.(v);
  };

  const [swatches, setSwatches] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [legendLevel, setLegendLevel] = useState(-1);
  const [announce, setAnnounce] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLSpanElement>(null);
  const engine = useRef<SkylineEngine | null>(null);
  const cornerRef = useRef<HTMLDivElement>(null);

  const plural = unitPlural ?? `${unit}s`;
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const fmt = formatCount ?? ((n: number) => nf.format(n));
  const df = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }), [locale]);
  const dfy = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }), [locale]);
  const dfl = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }), [locale]);
  const noun = (n: number) => (n === 1 ? unit : plural);
  const describe = (i: number) => {
    const c = model.cells[i];
    if (!c) return "";
    const what = c.detail ?? (c.count ? `${fmt(c.count)} ${noun(c.count)}` : `No ${plural}`);
    return `${what} on ${dfl.format(dayMs(c.date))}`;
  };

  // Everything the render loop reads, refreshed every render so it never closes over stale props.
  const cfg = useRef({ model, duration, heightScale, orbit, legendLevel, onCellClick, paused, target: view === "3d" ? 1 : 0, setActive, setSwatches, setAnnounce, describe });
  cfg.current = { model, duration, heightScale, orbit, legendLevel, onCellClick, paused, target: view === "3d" ? 1 : 0, setActive, setSwatches, setAnnounce, describe };

  // The box decides what fits around the chart.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    if (!root || !stage || typeof ResizeObserver === "undefined") return undefined;
    const read = () => {
      const r = root.getBoundingClientRect();
      setBox((b) => (Math.abs(b.width - r.width) < 1 && Math.abs(b.height - r.height) < 1 ? b : { width: r.width, height: r.height }));
      const s = stage.getBoundingClientRect();
      setStageBox((b) => (Math.abs(b.width - s.width) < 1 && Math.abs(b.height - s.height) < 1 ? b : { width: s.width, height: s.height }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(root);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    const palette = paletteRef.current;
    if (!root || !stage || !canvas || !tip || !palette) return undefined;
    const running = startSkylineRender({ root, stage, canvas, tip, palette, cfg, locale });
    if (!running) return undefined;
    engine.current = running.engine;
    return () => {
      running.dispose();
      engine.current = null;
    };
    // The loop reads everything else through cfg; it is built once per mount.
  }, [locale]);

  useEffect(() => {
    engine.current?.kick();
  }, [view, legendLevel, paused]);

  useEffect(() => {
    engine.current?.load();
  }, [model, heightScale]);

  // In 3D the stats stand in a column on the left; the chart keeps clear of it.
  useLayoutEffect(() => {
    const column = cornerRef.current;
    engine.current?.reserve(column ? column.offsetWidth + 20 : 0);
  });

  // The tooltip's width keeps it inside the box; measure it when its text changes.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (tip && active >= 0) engine.current?.tipWidth(tip.offsetWidth);
  }, [active, model]);

  const { stats } = model;
  const range = (a: string | null, b: string | null, withYear = false) => {
    if (!a || !b) return "—";
    const f = withYear ? dfy : df;
    return `${f.format(dayMs(a))} – ${f.format(dayMs(b))}`;
  };
  const is3d = view === "3d";
  // What fits around the chart, from the box the host gives it.
  // A wide, short box carries the stats in a column beside the chart.
  const side = showStats && box.width >= 520 && box.width >= box.height * 2.6 && box.height >= 110;
  const statCount = !showStats ? 0 : side ? (box.height >= 215 ? 4 : 3) : box.height < 170 ? 0 : box.width >= 470 ? 4 : box.width >= 250 ? 2 : 0;
  const corners = !side && statCount > 0 && stageBox.width >= 560 && stageBox.height >= 230;
  const showRow = statCount > 0 && !(is3d && corners);
  const footer = showLegend && box.height >= 120;
  const bigSize = Math.round(Math.max(22, Math.min(40, stageBox.width * 0.045, stageBox.height * 0.13)));
  // The 3D column stacks three or four of them, so they share the height.
  const sideSize = Math.round(Math.max(22, Math.min(bigSize, stageBox.height * 0.1)));
  const span = stats.first && stats.last ? Math.round((dayMs(stats.last) - dayMs(stats.first)) / DAY_MS / 7) : 0;
  const statBlocks: StatBlock[] = [
    { label: span >= 52 ? "Last year" : `Last ${span} weeks`, short: span >= 52 ? "Last year" : `${span} weeks`, value: fmt(stats.total), unit: noun(stats.total), sub: range(stats.first, stats.last, true) },
    { label: "Current streak", short: "Streak", value: nf.format(stats.current.days), unit: stats.current.days === 1 ? "day" : "days", sub: range(stats.current.start, stats.current.end) },
    { label: "Busiest day", short: "Best day", value: fmt(stats.busiest.count), unit: noun(stats.busiest.count), sub: stats.busiest.date ? df.format(dayMs(stats.busiest.date)) : "—" },
    { label: "Longest streak", short: "Longest", value: nf.format(stats.longest.days), unit: stats.longest.days === 1 ? "day" : "days", sub: range(stats.longest.start, stats.longest.end) },
  ];
  const levelNames = [`No ${plural}`, "Light", "Moderate", "Heavy", "Heaviest"];
  const hint = is3d && orbit ? "Drag to orbit · double-click to reset" : "Hover a day · arrow keys to explore";
  const activeCell = active >= 0 ? model.cells[active] : undefined;

  return (
    <div ref={rootRef} className={cn("ade-skyline", className)} data-view={view} data-side={side || undefined}>
      {/* Resolved by the browser from the theme tokens; the canvas paints these. */}
      <span ref={paletteRef} className="ade-skyline-palette" aria-hidden>
        <i /><i /><i /><i /><i />
      </span>
      {title || showToggle ? (
        <div className="ade-skyline-head">
          <div className="ade-skyline-title">{title}</div>
          {showToggle ? <ContributionSkylineToggle view={view} onChange={setView} /> : null}
        </div>
      ) : null}
      <div className="ade-skyline-row" data-shown={showRow || undefined} aria-hidden={!showRow} style={{ ["--skyline-ms" as string]: `${duration}ms` }}>
        <dl className="ade-skyline-stats" data-count={statCount}>
          {statBlocks.slice(0, statCount || 4).map((block, index) => (
            <div key={block.label} className="ade-skyline-stat" data-lead={index === 0 || undefined}>
              <dt className="kit-eyebrow" title={block.label}>{side && index > 0 ? block.short : block.label}</dt>
              <dd>
                <span className="ade-skyline-stat-value kit-num">{block.value}</span>
                <span className="ade-skyline-stat-unit">{block.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div ref={stageRef} className="ade-skyline-stage">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label={`${fmt(stats.total)} ${noun(stats.total)} between ${range(stats.first, stats.last, true)}, shown as a ${is3d ? "3D skyline" : "heat map"}. Use the arrow keys to read individual days.`}
          className="ade-skyline-canvas"
          style={{ touchAction: is3d && orbit ? "pan-y" : "auto" }}
        />
        {corners ? (
          <>
            <div ref={cornerRef} className="ade-skyline-corner" data-at="side" aria-hidden={!is3d} data-shown={is3d || undefined} style={{ transitionDelay: is3d ? `${Math.round(duration * 0.55)}ms` : "0ms" }}>
              {(stageBox.height >= 300 ? [0, 2, 3, 1] : [0, 1, 2]).map((index) => (
                <CornerStat key={statBlocks[index]!.label} block={statBlocks[index]!} size={sideSize} align="start" />
              ))}
            </div>
          </>
        ) : null}
        <div ref={tipRef} role="tooltip" aria-hidden={active < 0} className="ade-skyline-tip" data-shown={active >= 0 || undefined}>
          {activeCell ? (
            <>
              <strong>{activeCell.detail ?? (activeCell.count ? `${fmt(activeCell.count)} ${noun(activeCell.count)}` : `No ${plural}`)}</strong>
              <span> · {dfy.format(dayMs(activeCell.date))}</span>
            </>
          ) : " "}
          <i aria-hidden className="ade-skyline-tip-arrow" />
        </div>
      </div>
      {footer ? (
        <div className="ade-skyline-foot">
          <span className="ade-skyline-hint">{box.width >= 360 ? hint : null}</span>
          <div className="ade-skyline-legend" onMouseLeave={() => setLegendLevel(-1)}>
            <span>Less</span>
            {(swatches.length === 5 ? swatches : ["", "", "", "", ""]).map((color, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Highlight ${levelNames[i]!.toLowerCase()} days`}
                aria-pressed={legendLevel === i}
                title={levelNames[i]}
                onMouseEnter={() => setLegendLevel(i)}
                onFocus={() => setLegendLevel(i)}
                onBlur={() => setLegendLevel(-1)}
                onClick={() => setLegendLevel((l) => (l === i ? -1 : i))}
                style={{ background: color || undefined }}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      ) : null}
      <p aria-live="polite" className="sr-only">{announce}</p>
    </div>
  );
}
