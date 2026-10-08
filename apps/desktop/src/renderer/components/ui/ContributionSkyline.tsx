import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Cube, GridFour } from "@phosphor-icons/react";
import { cn } from "./cn";
import "./contributionSkyline.css";

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

// #region contributions
// Pure: dates, grid, stats, levels, camera and colour maths.

export type ContributionDay = {
  date: string;
  count: number;
  /** A line for the tooltip ("3 chats · 2 commits · 1.2M tokens"); the count is used when absent. */
  detail?: string;
};
export type SkylineCell = { date: string; count: number; detail?: string; level: number; week: number; day: number };
export type SkylineStreak = { days: number; start: string | null; end: string | null };
export type ContributionStats = {
  total: number;
  first: string | null;
  last: string | null;
  busiest: { count: number; date: string | null };
  longest: SkylineStreak;
  current: SkylineStreak;
};
type RGBA = [number, number, number, number];

const DAY_MS = 86400000;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeInOutCubic = (x: number): number => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** UTC midnight → "YYYY-MM-DD". */
const toKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** "YYYY-MM-DD" read literally (no timezone drift), a Date by its local day, a number as UTC. */
export const dayMs = (v: string | number | Date): number => {
  if (typeof v === "number") return Math.floor(v / DAY_MS) * DAY_MS;
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
    v = new Date(v);
  }
  return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
};

/** 0 for an empty day, else 1–4 by quarters of `busy`. Anything at or past `busy` is 4. */
export const levelOf = (count: number, busy: number): number =>
  count <= 0 ? 0 : busy <= 0 ? 4 : 1 + Math.min(3, Math.floor((count / busy) * 4));

/**
 * The grid: columns are weeks, rows are weekdays (row 0 = `weekStart`), the
 * last column holding `endMs`. Levels 1–4 split the non-zero days by their
 * share of a busy day (the 95th percentile), so one freak day can't wash
 * every other day out to level 1.
 */
export const buildGrid = (data: readonly ContributionDay[], endMs: number, weeks: number, weekStart = 0) => {
  const counts = new Map<string, { count: number; detail?: string }>();
  for (const d of data) {
    if (!d || typeof d.date !== "string") continue;
    const ms = dayMs(d.date);
    const c = Number(d.count);
    if (!Number.isFinite(ms) || !(c > 0) || !Number.isFinite(c)) continue;
    const k = toKey(ms);
    const prev = counts.get(k);
    counts.set(k, { count: (prev?.count ?? 0) + c, detail: d.detail ?? prev?.detail });
  }
  let start = endMs - (Math.max(1, weeks) * 7 - 1) * DAY_MS;
  start -= ((new Date(start).getUTCDay() - weekStart + 7) % 7) * DAY_MS;
  // Aligning back can add a column; keep exactly `weeks`.
  while ((endMs - start) / DAY_MS + 1 > weeks * 7) start += 7 * DAY_MS;
  const cells: SkylineCell[] = [];
  for (let ms = start, i = 0; ms <= endMs; ms += DAY_MS, i++) {
    const date = toKey(ms);
    const entry = counts.get(date);
    cells.push({ date, count: entry?.count ?? 0, detail: entry?.detail, level: 0, week: Math.floor(i / 7), day: i % 7 });
  }
  const nz = cells.map((c) => c.count).filter((c) => c > 0).sort((a, b) => a - b);
  const busy = nz.length ? nz[Math.floor(0.95 * (nz.length - 1))]! : 0;
  for (const c of cells) c.level = levelOf(c.count, busy);
  // Heights scale to a busy day too, with headroom, so one enormous day stays the
  // tallest tower without flattening the rest of the street.
  const max = nz.length ? Math.min(nz[nz.length - 1]!, busy * 1.6) : 0;
  return { cells, weeks: cells.length ? cells[cells.length - 1]!.week + 1 : 0, max };
};

/** Total, busiest day, longest run, and the run that reaches today (or yesterday: today isn't over). */
export const computeStats = (cells: readonly SkylineCell[]): ContributionStats => {
  let total = 0;
  let best = 0;
  let bestDate: string | null = null;
  let run = 0;
  let runStart: string | null = null;
  let longest: SkylineStreak = { days: 0, start: null, end: null };
  for (const c of cells) {
    total += c.count;
    if (c.count > best) {
      best = c.count;
      bestDate = c.date;
    }
    if (c.count > 0) {
      if (run === 0) runStart = c.date;
      run++;
      if (run > longest.days) longest = { days: run, start: runStart, end: c.date };
    } else run = 0;
  }
  let j = cells.length - 1;
  if (j >= 0 && cells[j]!.count === 0) j--;
  const endAt = j;
  while (j >= 0 && cells[j]!.count > 0) j--;
  const days = endAt - j;
  const current: SkylineStreak = days > 0 ? { days, start: cells[j + 1]!.date, end: cells[endAt]!.date } : { days: 0, start: null, end: null };
  return {
    total,
    first: cells.length ? cells[0]!.date : null,
    last: cells.length ? cells[cells.length - 1]!.date : null,
    busiest: { count: best, date: bestDate },
    longest,
    current,
  };
};

/** A label on each week whose first day starts a new month; a cramped first label is dropped. */
const monthLabels = (cells: readonly SkylineCell[], weeks: number, locale?: string) => {
  const fmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const out: { week: number; label: string }[] = [];
  let prev = -1;
  for (let w = 0; w < weeks; w++) {
    const c = cells[w * 7];
    if (!c) break;
    const m = +c.date.slice(5, 7);
    if (m !== prev) out.push({ week: w, label: fmt.format(dayMs(c.date)) });
    prev = m;
  }
  if (out.length > 1 && out[1]!.week - out[0]!.week < 3) out.shift();
  return out;
};

/** Box height in grid units. Empty days are thin slabs; a busy day is ~7.6 cells tall, an outlier a little more. */
const barHeight = (count: number, max: number, scale = 1): number =>
  count > 0 && max > 0 ? 0.4 + Math.pow(Math.min(1.15, count / max), 0.85) * 7.2 * scale : 0.2;

/** Share of the morph each bar spends waiting: the wave sweeps oldest week → newest. */
const WAVE = 0.42;

/** 0 → 1 as a bar rises during the morph. Every bar is flat at t=0 and fully up at t=1. */
const riseAt = (t: number, week: number, weeks: number, day: number): number => {
  const d = (weeks > 1 ? week / (weeks - 1) : 0) * 0.36 + (day / 6) * 0.06;
  return easeOutCubic((t - d) / (1 - WAVE));
};

/** The corner view's turn. A wide, short box looks along the street instead, so the skyline fills it. */
const YAW_3D = Math.PI / 4;
const yawForAspect = (aspect: number): number =>
  aspect >= 3.2 ? (14 * Math.PI) / 180 : aspect >= 2.2 ? (22 * Math.PI) / 180 : aspect >= 1.6 ? (32 * Math.PI) / 180 : YAW_3D;
const ELEV_3D = (34 * Math.PI) / 180;
const YAW_RANGE: [number, number] = [(8 * Math.PI) / 180, (82 * Math.PI) / 180];
const ELEV_RANGE: [number, number] = [(18 * Math.PI) / 180, (62 * Math.PI) / 180];

type Cam = { cs: number; sn: number; se: number; ce: number };

/**
 * e=0 looks straight down (a plain heat map); e=1 is the isometric corner
 * view. Orbit offsets apply in proportion to e, so the flat view never tilts.
 */
const camera = (e: number, dYaw = 0, dElev = 0, baseYaw = YAW_3D): Cam => {
  const yaw = Math.min(YAW_RANGE[1], Math.max(0, lerp(0, baseYaw + dYaw, e)));
  const elev = lerp(Math.PI / 2, Math.min(ELEV_RANGE[1], Math.max(ELEV_RANGE[0], ELEV_3D + dElev)), e);
  return { cs: Math.cos(yaw), sn: Math.sin(yaw), se: Math.sin(elev), ce: Math.cos(elev) };
};

/** World (x = week, y = weekday, z = up) → screen, before scale/offset. */
const project = (c: Cam, x: number, y: number, z: number): [number, number] => [
  x * c.cs - y * c.sn,
  (x * c.sn + y * c.cs) * c.se - z * c.ce,
];
// #endregion

type View = "2d" | "3d";

const FG_FALLBACK: RGBA = [240, 240, 242, 255];
const BG_FALLBACK: RGBA = [12, 11, 16, 255];

// Any CSS colour → sRGB + alpha, by letting the browser paint it (oklch, color-mix, color(srgb …)).
let probe: CanvasRenderingContext2D | null = null;
const toRGBA = (color: string, fallback: RGBA): RGBA => {
  if (!color) return fallback;
  if (!probe) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    probe = c.getContext("2d", { willReadFrequently: true });
  }
  if (!probe) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "rgba(0,0,0,0)";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  if (d[3]! < 4) return fallback;
  return [d[0]!, d[1]!, d[2]!, d[3]!];
};

const luminance = (c: RGBA): number => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const rgba = (r: number, g: number, b: number, a: number) =>
  `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${(a / 255).toFixed(3)})`;

const pointInQuad = (p: Float32Array, o: number, x: number, y: number): boolean => {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = p[o + k * 2]!;
    const ay = p[o + k * 2 + 1]!;
    const bx = p[o + ((k + 1) % 4) * 2]!;
    const by = p[o + ((k + 1) % 4) * 2 + 1]!;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
};

const quadPath = (ctx: CanvasRenderingContext2D, p: Float32Array, o: number, r: number) => {
  if (r < 0.3) {
    ctx.moveTo(p[o]!, p[o + 1]!);
    ctx.lineTo(p[o + 2]!, p[o + 3]!);
    ctx.lineTo(p[o + 4]!, p[o + 5]!);
    ctx.lineTo(p[o + 6]!, p[o + 7]!);
    ctx.closePath();
    return;
  }
  ctx.moveTo((p[o + 6]! + p[o]!) / 2, (p[o + 7]! + p[o + 1]!) / 2);
  for (let k = 0; k < 4; k++) {
    const b = (k + 1) % 4;
    ctx.arcTo(p[o + k * 2]!, p[o + k * 2 + 1]!, p[o + b * 2]!, p[o + b * 2 + 1]!, r);
  }
  ctx.closePath();
};

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
  const engine = useRef<{ kick: () => void; load: () => void; retheme: () => void; tipWidth: (w: number) => void } | null>(null);

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
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = reduceMq.matches;

    // morph: t is linear time 0 (2D) → 1 (3D); the camera eases it, the bars wave it
    let t = 0;
    let target = 0;
    let entered = false;
    // orbit offsets, eased toward their goals
    let yaw = 0;
    let elev = 0;
    let baseYaw = YAW_3D;
    let yawGoal = 0;
    let elevGoal = 0;
    // layout
    let W = 0;
    let H = 0;
    let dpr = 1;
    let gutter = 0;
    let labelW = 30;
    let font = "10px sans-serif";
    // colours: [empty, l1, l2, l3, l4] × rgba, eased toward the goal
    const col = new Float32Array(20);
    const colGoal = new Float32Array(20);
    let colReady = false;
    let fg: RGBA = FG_FALLBACK;
    let bg: RGBA = BG_FALLBACK;
    let muted: RGBA = FG_FALLBACK;
    // cells
    let n = 0;
    let weeksN = 0;
    let wk = new Float32Array(0);
    let dy = new Float32Array(0);
    let lv = new Uint8Array(0);
    let hgt = new Float32Array(0);
    let zs = new Float32Array(0);
    let hover = new Float32Array(0);
    let dim = new Float32Array(0);
    let polys = new Float32Array(0);
    let faces = new Uint8Array(0);
    let order: number[] = [];
    let months: { week: number; label: string }[] = [];
    let weekdayRows: { day: number; label: string }[] = [];
    // interaction
    let hovered = -1;
    let pinned = -1;
    let activeIdx = -1;
    let tipW = 0;
    let raf = 0;
    let last = 0;

    const load = () => {
      const m = cfg.current.model;
      n = m.cells.length;
      weeksN = m.weeks;
      if (wk.length !== n) {
        wk = new Float32Array(n);
        dy = new Float32Array(n);
        lv = new Uint8Array(n);
        hgt = new Float32Array(n);
        zs = new Float32Array(n);
        hover = new Float32Array(n);
        dim = new Float32Array(n);
        polys = new Float32Array(n * 24);
        faces = new Uint8Array(n);
        order = Array.from({ length: n }, (_, i) => i);
      }
      for (let i = 0; i < n; i++) {
        const c = m.cells[i]!;
        wk[i] = c.week;
        dy[i] = c.day;
        lv[i] = c.level;
        hgt[i] = barHeight(c.count, m.max, cfg.current.heightScale);
      }
      months = m.months;
      const wf = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
      weekdayRows = [];
      for (let d = 0; d < 7 && d < n; d++) {
        const dow = new Date(dayMs(m.cells[d]!.date)).getUTCDay();
        if (dow === 1 || dow === 3 || dow === 5) weekdayRows.push({ day: d, label: wf.format(dayMs(m.cells[d]!.date)) });
      }
      if (hovered >= n) hovered = -1;
      if (pinned >= n) pinned = -1;
      if (activeIdx >= n) activeIdx = -1;
    };

    // Colours come from the theme: the swatches are styled from ADE's tokens
    // (contributionSkyline.css), and the canvas paints what the browser resolved.
    const retheme = () => {
      const cs = getComputedStyle(root);
      fg = toRGBA(cs.color, FG_FALLBACK);
      const swatchEls = Array.from(palette.children) as HTMLElement[];
      const resolved = swatchEls.map((el) => getComputedStyle(el).backgroundColor);
      const bgProbe = getComputedStyle(palette).backgroundColor;
      bg = toRGBA(bgProbe, luminance(fg) > 0.5 ? BG_FALLBACK : [245, 243, 240, 255]);
      const mix = (a: RGBA, b: RGBA, k: number): RGBA => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, 255];
      muted = mix(bg, fg, 0.55);
      font = `400 10px ${cs.fontFamily || "sans-serif"}`;
      const all: RGBA[] = [0, 1, 2, 3, 4].map((k) => toRGBA(resolved[k] ?? "", k === 0 ? mix(bg, fg, 0.1) : fg));
      for (let k = 0; k < 5; k++) for (let ch = 0; ch < 4; ch++) colGoal[k * 4 + ch] = all[k]![ch]!;
      if (!colReady || reduced) {
        col.set(colGoal);
        colReady = true;
      }
      ctx.font = font;
      labelW = Math.ceil(Math.max(20, ...weekdayRows.map((r) => ctx.measureText(r.label).width))) + 8;
      const sw = all.map((c) => rgba(c[0], c[1], c[2], c[3]));
      cfg.current.setSwatches((prev) => (prev.join() === sw.join() ? prev : sw));
      kick();
    };

    // Projected extent of the scene for camera e, with each bar at zOf(i).
    const extent = (cam: Cam, e: number, full: boolean) => {
      const w = lerp(0.78, 0.9, e);
      const off = (1 - w) / 2;
      let minx = Infinity;
      let maxx = -Infinity;
      let miny = Infinity;
      let maxy = -Infinity;
      const add = (x: number, y: number, z: number) => {
        const p = project(cam, x, y, z);
        if (p[0] < minx) minx = p[0];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[1] > maxy) maxy = p[1];
      };
      for (let i = 0; i < n; i++) {
        const x0 = wk[i]! + off;
        const y0 = dy[i]! + off;
        const z = full ? hgt[i]! * e : zs[i]!;
        add(x0, y0, z);
        add(x0 + w, y0, z);
        add(x0, y0 + w, z);
        add(x0 + w, y0 + w, 0);
        add(x0, y0 + w, 0);
        add(x0 + w, y0, 0);
      }
      // room for the month labels that run along the front edge in 3D
      add(0, 7 + 1.5 * e, 0);
      add(weeksN, 7 + 1.5 * e, 0);
      return { minx, maxx, miny, maxy };
    };

    const relayout = () => {
      const w = Math.round(stage.clientWidth);
      const h = Math.round(stage.clientHeight);
      if (!w || !h || !n) return;
      W = w;
      H = h;
      // Narrow boxes give the weekday names' column to the grid; rows get too tight to label.
      gutter = W < 420 || H < 90 ? 0 : labelW;
      baseYaw = yawForAspect(W / H);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      draw();
    };

    const draw = () => {
      if (!W || !H || !n) return;
      const e = easeInOutCubic(t);
      const cam = camera(e, yaw, elev, baseYaw);
      for (let i = 0; i < n; i++) zs[i] = riseAt(t, wk[i]!, weeksN, dy[i]!) * hgt[i]!;
      const b = extent(cam, e, false);
      const labels2d = H >= 70;
      const pad = lerp(2, 12, e);
      const left = pad + gutter * (1 - e);
      const top = pad + (labels2d ? 16 : 0) * (1 - e);
      const aw = W - left - pad;
      const ah = H - top - pad;
      const bw = Math.max(1e-6, b.maxx - b.minx);
      const bh = Math.max(1e-6, b.maxy - b.miny);
      const s = Math.min(aw / bw, ah / bh);
      const ox = left + (aw - bw * s) / 2 - b.minx * s;
      const oy = top + (ah - bh * s) / 2 - b.miny * s;
      const { cs, sn, se, ce } = cam;
      const px = (x: number, y: number) => ox + (x * cs - y * sn) * s;
      const py = (x: number, y: number, z: number) => oy + ((x * sn + y * cs) * se - z * ce) * s;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      order.sort((a, c) => (wk[a]! + 0.5) * sn + (dy[a]! + 0.5) * cs - ((wk[c]! + 0.5) * sn + (dy[c]! + 0.5) * cs));

      const w = lerp(0.78, 0.9, e);
      const off = (1 - w) / 2;
      const radius = lerp(0.17, 0.03, e) * s;
      const outline = (1 - e) * 0.06;
      const lift = 0.7 * e;
      const ex = col[0]!;
      const ey = col[1]!;
      const ez = col[2]!;
      const ea = col[3]!;

      for (let k = 0; k < n; k++) {
        const i = order[k]!;
        const x0 = wk[i]! + off;
        const y0 = dy[i]! + off;
        const x1 = x0 + w;
        const y1 = y0 + w;
        const z = zs[i]! + hover[i]! * lift;
        const o = i * 24;
        // top
        polys[o] = px(x0, y0); polys[o + 1] = py(x0, y0, z);
        polys[o + 2] = px(x1, y0); polys[o + 3] = py(x1, y0, z);
        polys[o + 4] = px(x1, y1); polys[o + 5] = py(x1, y1, z);
        polys[o + 6] = px(x0, y1); polys[o + 7] = py(x0, y1, z);
        // +y face (left on screen)
        polys[o + 8] = px(x0, y1); polys[o + 9] = py(x0, y1, 0);
        polys[o + 10] = px(x1, y1); polys[o + 11] = py(x1, y1, 0);
        polys[o + 12] = polys[o + 4]!; polys[o + 13] = polys[o + 5]!;
        polys[o + 14] = polys[o + 6]!; polys[o + 15] = polys[o + 7]!;
        // +x face (right on screen)
        polys[o + 16] = px(x1, y0); polys[o + 17] = py(x1, y0, 0);
        polys[o + 18] = polys[o + 10]!; polys[o + 19] = polys[o + 11]!;
        polys[o + 20] = polys[o + 4]!; polys[o + 21] = polys[o + 5]!;
        polys[o + 22] = polys[o + 2]!; polys[o + 23] = polys[o + 3]!;

        const tall = z * ce * s;
        let f = 0;
        if (tall > 0.35 && w * cs * s > 0.35) f |= 1;
        if (tall > 0.35 && w * sn * s > 0.35) f |= 2;
        faces[i] = f;

        const L = lv[i]! * 4;
        let r = col[L]!;
        let g = col[L + 1]!;
        let bl = col[L + 2]!;
        let a = col[L + 3]!;
        const d = dim[i]!;
        if (d > 0.002) {
          r += (ex - r) * 0.72 * d;
          g += (ey - g) * 0.72 * d;
          bl += (ez - bl) * 0.72 * d;
          a += (ea - a) * 0.72 * d;
        }
        const hv = hover[i]!;
        if (hv > 0.002) {
          const m = 0.16 * hv;
          r += (fg[0] - r) * m;
          g += (fg[1] - g) * m;
          bl += (fg[2] - bl) * m;
          a += (255 - a) * hv;
        }
        if (f & 1) {
          ctx.beginPath();
          quadPath(ctx, polys, o + 8, 0);
          ctx.fillStyle = rgba(r * 0.84, g * 0.84, bl * 0.84, a);
          ctx.fill();
        }
        if (f & 2) {
          ctx.beginPath();
          quadPath(ctx, polys, o + 16, 0);
          ctx.fillStyle = rgba(r * 0.68, g * 0.68, bl * 0.68, a);
          ctx.fill();
        }
        ctx.beginPath();
        quadPath(ctx, polys, o, radius);
        ctx.fillStyle = rgba(r, g, bl, a);
        ctx.fill();
        if (outline > 0.004) {
          ctx.strokeStyle = `rgba(${fg[0]},${fg[1]},${fg[2]},${outline.toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (hv > 0.02) {
          ctx.strokeStyle = `rgba(${fg[0]},${fg[1]},${fg[2]},${(0.85 * hv).toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // Labels: along the top and left in 2D, along the front edge in 3D. They fade, never pop.
      ctx.font = font;
      const a2 = labels2d ? 1 - smoothstep(0, 0.4, e) : 0;
      const a3 = smoothstep(0.62, 1, e);
      const mutedRGB = `${Math.round(muted[0])},${Math.round(muted[1])},${Math.round(muted[2])}`;
      if (a2 > 0.004) {
        ctx.fillStyle = `rgba(${mutedRGB},${a2.toFixed(3)})`;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        let edge = -Infinity;
        for (const m of months) {
          const x = px(m.week + off, -0.3);
          const tw = ctx.measureText(m.label).width;
          if (x < edge || x + tw > W) continue;
          ctx.fillText(m.label, x, py(m.week + off, -0.3, 0) - 3);
          edge = x + tw + 6;
        }
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        if (gutter > 0) for (const r of weekdayRows) ctx.fillText(r.label, px(0, r.day + 0.5) - 6, py(0, r.day + 0.5, 0));
      }
      if (a3 > 0.004) {
        ctx.fillStyle = `rgba(${mutedRGB},${a3.toFixed(3)})`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        let edge = -Infinity;
        for (const m of months) {
          const x = px(m.week + 0.5, 7.3);
          const tw = ctx.measureText(m.label).width;
          if (x < edge || x + tw > W) continue;
          ctx.fillText(m.label, x, py(m.week + 0.5, 7.3, 0) + 2);
          edge = x + tw + 10;
        }
      }

      // The tooltip rides the active cell through morphs and orbits.
      if (activeIdx >= 0 && activeIdx < n) {
        const i = activeIdx;
        const z = zs[i]! + hover[i]! * lift;
        const tx = px(wk[i]! + 0.5, dy[i]! + 0.5);
        const ty = Math.min(py(wk[i]! + off, dy[i]! + off, z), py(wk[i]! + off + w, dy[i]! + off, z), py(wk[i]! + off, dy[i]! + off + w, z));
        const half = tipW / 2;
        const cx = Math.min(W - half - 2, Math.max(half + 2, tx));
        // Below the cell when there is no room above it.
        const above = ty - 8 > 30;
        tip.style.transform = above
          ? `translate(${(cx - half).toFixed(1)}px,${(ty - 8).toFixed(1)}px) translateY(-100%)`
          : `translate(${(cx - half).toFixed(1)}px,${(py(wk[i]! + 0.5, dy[i]! + 1, 0) + 8).toFixed(1)}px)`;
        tip.dataset.below = above ? "" : "true";
        tip.style.setProperty("--arrow", `${(tx - cx + half).toFixed(1)}px`);
      }
    };

    const tick = (now: number) => {
      raf = 0;
      if (cfg.current.paused) return;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      let moving = false;

      if (t !== target) {
        const step = reduced ? 1 : (dt * 1000) / Math.max(1, cfg.current.duration);
        t = target > t ? Math.min(target, t + step) : Math.max(target, t - step);
        moving = true;
      }

      const ko = reduced ? 1 : 1 - Math.exp(-dt * 12);
      yaw += (yawGoal - yaw) * ko;
      elev += (elevGoal - elev) * ko;
      if (Math.abs(yawGoal - yaw) > 1e-4 || Math.abs(elevGoal - elev) > 1e-4) moving = true;
      else {
        yaw = yawGoal;
        elev = elevGoal;
      }

      const kc = reduced ? 1 : 1 - Math.exp(-dt * 7);
      for (let k = 0; k < 20; k++) {
        const d = colGoal[k]! - col[k]!;
        if (Math.abs(d) > 0.4) {
          col[k] = col[k]! + d * kc;
          moving = true;
        } else col[k] = colGoal[k]!;
      }

      const kh = reduced ? 1 : 1 - Math.exp(-dt * 16);
      const kd = reduced ? 1 : 1 - Math.exp(-dt * 10);
      const leg = cfg.current.legendLevel;
      for (let i = 0; i < n; i++) {
        const hg = i === activeIdx ? 1 : 0;
        const dg = leg >= 0 && lv[i] !== leg ? 1 : 0;
        const h = hover[i]!;
        const d = dim[i]!;
        if (h !== hg) {
          hover[i] = Math.abs(hg - h) < 0.003 ? hg : h + (hg - h) * kh;
          moving = true;
        }
        if (d !== dg) {
          dim[i] = Math.abs(dg - d) < 0.003 ? dg : d + (dg - d) * kd;
          moving = true;
        }
      }

      draw();
      if (moving) raf = requestAnimationFrame(tick);
    };

    const kick = () => {
      if (raf || cfg.current.paused) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };

    // The active day is the hovered one, else the pinned one (tap, click or keyboard).
    const refreshActive = () => {
      const next = hovered >= 0 ? hovered : pinned;
      if (next === activeIdx) return;
      activeIdx = next;
      cfg.current.setActive(next);
      kick();
    };

    const hit = (x: number, y: number): number => {
      for (let k = n - 1; k >= 0; k--) {
        const i = order[k]!;
        const o = i * 24;
        if (pointInQuad(polys, o, x, y)) return i;
        if (faces[i]! & 1 && pointInQuad(polys, o + 8, x, y)) return i;
        if (faces[i]! & 2 && pointInQuad(polys, o + 16, x, y)) return i;
      }
      return -1;
    };

    const local = (ev: PointerEvent | MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top] as const;
    };

    let drag: { id: number; x: number; y: number; yaw: number; elev: number; moved: boolean; orbit: boolean; mouse: boolean } | null = null;

    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const can = cfg.current.orbit && target === 1;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, yaw: yawGoal, elev: elevGoal, moved: false, orbit: can, mouse: ev.pointerType === "mouse" };
      if (can) {
        try {
          canvas.setPointerCapture(ev.pointerId);
        } catch {
          // capture is a nicety
        }
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (drag && drag.orbit && ev.pointerId === drag.id) {
        const dx = ev.clientX - drag.x;
        const dyy = ev.clientY - drag.y;
        if (drag.moved || Math.hypot(dx, dyy) > 4) {
          drag.moved = true;
          yawGoal = Math.min(YAW_RANGE[1] - baseYaw, Math.max(YAW_RANGE[0] - baseYaw, drag.yaw + dx * 0.006));
          if (drag.mouse) elevGoal = Math.min(ELEV_RANGE[1] - ELEV_3D, Math.max(ELEV_RANGE[0] - ELEV_3D, drag.elev + dyy * 0.004));
          canvas.style.cursor = "grabbing";
          hovered = -1;
          refreshActive();
          kick();
          return;
        }
      }
      if (ev.pointerType !== "mouse") return;
      const [x, y] = local(ev);
      const i = hit(x, y);
      if (i !== hovered) {
        hovered = i;
        refreshActive();
      }
      canvas.style.cursor = cfg.current.orbit && target === 1 ? "grab" : i >= 0 ? "pointer" : "default";
    };

    const onUp = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const wasMoved = drag.moved;
      drag = null;
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      canvas.style.cursor = cfg.current.orbit && target === 1 ? "grab" : "default";
      if (wasMoved) return;
      const [x, y] = local(ev);
      const i = hit(x, y);
      pinned = i === pinned ? -1 : i;
      if (ev.pointerType !== "mouse") hovered = -1;
      refreshActive();
      if (i >= 0) {
        const c = cfg.current.model.cells[i]!;
        cfg.current.onCellClick?.({ date: c.date, count: c.count, detail: c.detail });
      }
    };

    const onCancel = () => {
      drag = null;
    };

    const onLeave = () => {
      if (drag) return;
      hovered = -1;
      refreshActive();
    };

    const onDbl = () => {
      yawGoal = 0;
      elevGoal = 0;
      kick();
    };

    const onKey = (ev: KeyboardEvent) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Escape", "Enter", " "];
      if (!keys.includes(ev.key) || !n) return;
      ev.preventDefault();
      if (ev.key === "Escape") {
        pinned = -1;
        hovered = -1;
        refreshActive();
        return;
      }
      let i = pinned >= 0 ? pinned : activeIdx >= 0 ? activeIdx : n - 1;
      if (ev.key === "Enter" || ev.key === " ") {
        const c = cfg.current.model.cells[i]!;
        cfg.current.onCellClick?.({ date: c.date, count: c.count, detail: c.detail });
        return;
      }
      if (pinned >= 0 || activeIdx >= 0) {
        if (ev.key === "ArrowLeft") i -= 7;
        if (ev.key === "ArrowRight") i += 7;
        if (ev.key === "ArrowUp") i -= 1;
        if (ev.key === "ArrowDown") i += 1;
        if (ev.key === "Home") i = 0;
        if (ev.key === "End") i = n - 1;
      }
      i = Math.max(0, Math.min(n - 1, i));
      pinned = i;
      hovered = -1;
      refreshActive();
      cfg.current.setAnnounce(cfg.current.describe(i));
    };

    const onBlur = () => {
      pinned = -1;
      refreshActive();
    };

    const setTarget = () => {
      const goal = cfg.current.target;
      if (!entered) return;
      if (goal !== target) {
        target = goal;
        if (goal === 0) {
          yawGoal = 0;
          elevGoal = 0;
        }
        canvas.style.cursor = cfg.current.orbit && target === 1 ? "grab" : "default";
        kick();
      }
    };

    load();
    retheme();
    relayout();

    // The 3D view rises out of the flat one the first time it is seen.
    const enter = () => {
      if (entered) return;
      entered = true;
      if (reduced) t = cfg.current.target;
      setTarget();
      draw();
    };
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((en) => en.isIntersecting)) {
            enter();
            io?.disconnect();
          }
        },
        { threshold: 0.35 },
      );
      io.observe(stage);
    } else enter();

    const ro = new ResizeObserver(() => {
      if (Math.round(stage.clientWidth) !== W || Math.round(stage.clientHeight) !== H) relayout();
    });
    ro.observe(stage);

    // Theme, mode and picture changes repaint from the new tokens.
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-theme-id", "data-scene"] });
    const onReduce = () => {
      reduced = reduceMq.matches;
      kick();
    };
    reduceMq.addEventListener("change", onReduce);

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("blur", onBlur);

    engine.current = {
      kick: () => {
        setTarget();
        kick();
      },
      load: () => {
        load();
        retheme();
        relayout();
      },
      retheme,
      tipWidth: (w: number) => {
        tipW = w;
        draw();
      },
    };

    return () => {
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      ro.disconnect();
      mo.disconnect();
      reduceMq.removeEventListener("change", onReduce);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("blur", onBlur);
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
            <div className="ade-skyline-corner" data-at="top" aria-hidden={!is3d} data-shown={is3d || undefined} style={{ transitionDelay: is3d ? `${Math.round(duration * 0.55)}ms` : "0ms" }}>
              <CornerStat block={statBlocks[0]!} size={bigSize} align="end" />
              <CornerStat block={statBlocks[2]!} size={bigSize} align="end" />
            </div>
            <div className="ade-skyline-corner" data-at="bottom" aria-hidden={!is3d} data-shown={is3d || undefined} style={{ transitionDelay: is3d ? `${Math.round(duration * 0.65)}ms` : "0ms" }}>
              <CornerStat block={statBlocks[3]!} size={bigSize} align="start" />
              <CornerStat block={statBlocks[1]!} size={bigSize} align="start" />
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
