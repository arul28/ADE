import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { prefersReducedMotion } from "./cloudDashboardModel";

/**
 * ADE Cloud's city: one block per item on an isometric ground. Height is the
 * item's size, the warm windows mean awake, an amber flag marks an item not
 * used for a long time. ADE's own drawing (the owner's pick, "blue glass,
 * warm windows").
 *
 * It costs nothing at rest: plain SVG with no loop. It moves only on an
 * event: a new block rises, a removed one sinks, a block that wakes lights
 * its windows (CSS transitions). Reduced motion skips all of it.
 */

export type CityItem = {
  key: string;
  name: string;
  /** The line under the name. */
  sub: string;
  /** Screen-reader text for the block. */
  aria: string;
  /** The readout's lines under the name, on hover or selection. */
  detail: string[];
  /** The block's height, in the same unit for every item (GB). */
  size: number;
  /** 1 to 4: the footprint grows with it, and a roof plant room (2+) and an antenna (3+) appear. */
  rank: number;
  awake: boolean;
  old: boolean;
  /** No block yet: a dashed plot (a lane without a computer). */
  empty?: boolean;
};

const UNIT = 46;
const COS = 0.8660254;
const FOOT = [0, 1.35, 1.55, 1.8, 2.0];
/** Space between plots on the ground, in ground units. */
const PLOT_STEP = 2.6;
const VIEW_W = 720;
const RISE_MS = 1100;
const SINK_MS = 820;

type Pt = [number, number];
const pts = (list: Pt[]) => list.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

/** A fixed hash: the same block always lights the same windows. */
function hash(a: number, b: number, c: number, d: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 1440662683 + d * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function seedOf(key: string): number {
  let seed = 7;
  for (let i = 0; i < key.length; i += 1) seed = (seed * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(seed) % 9973;
}

type Geometry = {
  unit: number;
  cx: number;
  cy: number;
  ox: number;
  oy: number;
  ground: number;
  /** Pixels of height per unit of size. */
  scale: number;
  plots: Array<{ cx: number; cy: number }>;
  iso: (x: number, y: number, z: number) => Pt;
};

function geometryFor(count: number, maxSize: number, compact: boolean): Geometry {
  const cols = Math.max(2, Math.ceil(Math.sqrt(Math.max(1, count))));
  const ground = cols * PLOT_STEP + 1.4;
  const unit = Math.min(UNIT, (VIEW_W - 100) / (ground * 2 * COS));
  const cx = unit * COS;
  const cy = unit * 0.5;
  const tallest = (compact ? 120 : 150) * (unit / UNIT);
  const scale = Math.min(21 * (unit / UNIT), tallest / Math.max(1, maxSize));
  const ox = VIEW_W / 2;
  // Room above the back plot for the tallest block and its label, no more.
  const oy = Math.max(96, maxSize * scale + 54);
  const plots = Array.from({ length: count }, (_, index) => ({
    cx: 0.7 + PLOT_STEP / 2 + (index % cols) * PLOT_STEP,
    cy: 0.7 + PLOT_STEP / 2 + Math.floor(index / cols) * PLOT_STEP,
  }));
  return { unit, cx, cy, ox, oy, ground, scale, plots, iso: (x, y, z) => [ox + (x - y) * cx, oy + (x + y) * cy - z] };
}

type Placed = CityItem & { cx: number; cy: number; w: number; seed: number; leaving?: boolean };

/**
 * Items that left keep their place while they sink. Returns the items to
 * draw, with `leaving` keys, and a callback to drop one once it has sunk.
 */
function useLeavingItems(items: readonly CityItem[], animate: boolean): { drawn: Array<CityItem & { leaving?: boolean }>; entering: Set<string>; drop: (key: string) => void } {
  const previous = useRef<CityItem[] | null>(null);
  const [leaving, setLeaving] = useState<Array<{ item: CityItem; index: number }>>([]);
  const [entering, setEntering] = useState<Set<string>>(() => new Set());
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = items.slice();
    // The first list is the city as it stands: nothing rises.
    if (!before || !animate) return;
    const now = new Set(items.map((item) => item.key));
    const was = new Set(before.map((item) => item.key));
    const gone = before.flatMap((item, index) => (now.has(item.key) ? [] : [{ item, index }]));
    const added = items.filter((item) => !was.has(item.key) && !item.empty).map((item) => item.key);
    if (gone.length) setLeaving((current) => [...current.filter((entry) => !now.has(entry.item.key)), ...gone]);
    if (added.length) setEntering((current) => new Set([...current, ...added]));
  }, [items, animate]);
  const drawn = useMemo(() => {
    const list: Array<CityItem & { leaving?: boolean }> = items.slice();
    for (const entry of leaving) list.splice(Math.min(entry.index, list.length), 0, { ...entry.item, leaving: true });
    return list;
  }, [items, leaving]);
  const drop = useCallback((key: string) => {
    setLeaving((current) => (current.some((entry) => entry.item.key === key) ? current.filter((entry) => entry.item.key !== key) : current));
    setEntering((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  return { drawn, entering, drop };
}

export function CloudCity({
  items,
  selectedKey,
  onSelect,
  onOpen,
  label,
  compact = false,
  stars = true,
}: {
  items: readonly CityItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Enter or a double click: look inside. */
  onOpen?: (key: string) => void;
  label: string;
  compact?: boolean;
  stars?: boolean;
}) {
  const id = `adecd${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const animate = !prefersReducedMotion();
  const { drawn, entering, drop } = useLeavingItems(items, animate);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const maxSize = Math.max(1, ...drawn.map((item) => (item.empty ? 0 : item.size)));
  const geo = useMemo(() => geometryFor(drawn.length, maxSize, compact), [drawn.length, maxSize, compact]);
  const placed: Placed[] = useMemo(
    () => drawn
      // The biggest blocks take the back plots, so they never hide a smaller one.
      .slice()
      .sort((a, b) => (b.empty ? 0 : b.size) - (a.empty ? 0 : a.size) || a.key.localeCompare(b.key))
      .map((item, index) => ({ ...item, ...geo.plots[index]!, w: FOOT[Math.max(1, Math.min(4, item.rank))]!, seed: seedOf(item.key) }))
      // Back to front, so nearer blocks cover farther ones.
      .sort((a, b) => a.cx + a.cy - (b.cx + b.cy) || a.cx - b.cx),
    [drawn, geo],
  );
  const groundPts: Pt[] = [geo.iso(0, 0, 0), geo.iso(geo.ground, 0, 0), geo.iso(geo.ground, geo.ground, 0), geo.iso(0, geo.ground, 0)];
  // The ground's near corner fades out; the view stops a little after it.
  const viewH = Math.ceil(geo.oy + geo.ground * geo.unit * 0.8 + 8);
  // A crowded city names the block under the pointer only (the list names them all).
  const labels = drawn.length <= 6;
  const center = geo.iso(geo.ground / 2, geo.ground / 2, 0);
  const radius = geo.ground * geo.cx * 0.98;
  const ellipse = `translate(${center[0].toFixed(1)} ${center[1].toFixed(1)}) scale(1 .58) translate(${(-center[0]).toFixed(1)} ${(-center[1]).toFixed(1)})`;

  const order = items.map((item) => item.key);
  const move = (step: number | "first" | "last") => {
    if (!order.length) return;
    const at = selectedKey ? order.indexOf(selectedKey) : -1;
    const next = step === "first" ? 0 : step === "last" ? order.length - 1 : Math.max(0, Math.min(order.length - 1, (at < 0 ? 0 : at) + step));
    onSelect(order[next]!);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(-1);
    else if (event.key === "Home") move("first");
    else if (event.key === "End") move("last");
    else if (event.key === "Enter" && selectedKey && onOpen) onOpen(selectedKey);
    else return;
    event.preventDefault();
  };
  const active = hoverKey ? placed.find((item) => item.key === hoverKey && !item.leaving) ?? null : null;

  return (
    <div className="adecd-city-wrap">
      <div
        className="adecd-city"
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={selectedKey ? `${id}-${seedOf(selectedKey)}` : undefined}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setHoverKey(null)}
      >
        <svg viewBox={`0 0 ${VIEW_W} ${viewH}`} preserveAspectRatio="xMidYMid meet" className="adecd-city-svg">
          <defs>
            <linearGradient id={`${id}-roof`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" style={{ stopColor: "var(--adecd-roof1)" }} /><stop offset="1" style={{ stopColor: "var(--adecd-roof2)" }} /></linearGradient>
            <linearGradient id={`${id}-fl`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: "var(--adecd-fl1)" }} /><stop offset="1" style={{ stopColor: "var(--adecd-fl2)" }} /></linearGradient>
            <linearGradient id={`${id}-fr`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: "var(--adecd-fr1)" }} /><stop offset="1" style={{ stopColor: "var(--adecd-fr2)" }} /></linearGradient>
            <radialGradient id={`${id}-glow`}><stop offset="0" style={{ stopColor: "var(--adecd-glow1)" }} /><stop offset=".45" style={{ stopColor: "var(--adecd-glow2)" }} /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
            <radialGradient id={`${id}-halo`}><stop offset="0" style={{ stopColor: "var(--adecd-glow2)" }} /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
            <radialGradient id={`${id}-puff`}><stop offset="0" stopColor="#E9F2FF" stopOpacity=".95" /><stop offset=".55" stopColor="#C8DDFF" stopOpacity=".55" /><stop offset="1" stopColor="#9DC4FF" stopOpacity="0" /></radialGradient>
            <radialGradient id={`${id}-ground`} gradientUnits="userSpaceOnUse" cx={center[0]} cy={center[1]} r={radius} gradientTransform={ellipse}><stop offset="0" style={{ stopColor: "var(--adecd-ground1)" }} /><stop offset="1" style={{ stopColor: "var(--adecd-ground2)" }} /></radialGradient>
            <radialGradient id={`${id}-fade`} gradientUnits="userSpaceOnUse" cx={center[0]} cy={center[1]} r={radius} gradientTransform={ellipse}><stop offset="0" stopColor="#fff" /><stop offset=".6" stopColor="#fff" /><stop offset="1" stopColor="#000" /></radialGradient>
            <mask id={`${id}-gm`}><rect x="0" y="0" width={VIEW_W} height={viewH} fill={`url(#${id}-fade)`} /></mask>
            <filter id={`${id}-bloom`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" /></filter>
          </defs>
          {stars ? <Stars width={VIEW_W} height={geo.oy} /> : null}
          <g mask={`url(#${id}-gm)`}>
            <polygon points={pts(groundPts)} fill={`url(#${id}-ground)`} />
            <GroundGrid geo={geo} />
          </g>
          {placed.map((item) => {
            const w = item.w / 2 + 0.17;
            return <polygon key={`pad-${item.key}`} className="adecd-pad" points={pts([geo.iso(item.cx - w, item.cy - w, 0), geo.iso(item.cx + w, item.cy - w, 0), geo.iso(item.cx + w, item.cy + w, 0), geo.iso(item.cx - w, item.cy + w, 0)])} />;
          })}
          {placed.map((item) => <SelectionRing key={`sel-${item.key}`} item={item} geo={geo} on={item.key === selectedKey} />)}
          {placed.map((item) => (
            <Block
              key={item.key}
              domId={`${id}-${seedOf(item.key)}`}
              defs={id}
              item={item}
              geo={geo}
              selected={item.key === selectedKey}
              entering={entering.has(item.key)}
              leaving={item.leaving === true}
              animate={animate}
              labels={labels}
              onDone={drop}
              onHover={setHoverKey}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </svg>
      </div>
      {active ? <Readout item={active} geo={geo} viewH={viewH} lifted={active.key === selectedKey} /> : null}
    </div>
  );
}

const Stars = memo(function Stars({ width, height }: { width: number; height: number }) {
  const stars: ReactNode[] = [];
  for (let i = 0; i < 46; i += 1) {
    stars.push(
      <circle
        key={i}
        cx={(hash(i, 1, 7, 3) * width).toFixed(1)}
        cy={(hash(i, 2, 7, 3) * Math.max(40, height - 20)).toFixed(1)}
        r={(0.5 + hash(i, 3, 7, 3) * 0.8).toFixed(2)}
        opacity={(0.18 + hash(i, 4, 7, 3) * 0.5).toFixed(2)}
      />,
    );
  }
  return <g className="adecd-stars">{stars}</g>;
});

function GroundGrid({ geo }: { geo: Geometry }) {
  const lines: ReactNode[] = [];
  for (let i = 0.5; i < geo.ground; i += 0.5) {
    const a = geo.iso(i, 0, 0);
    const b = geo.iso(i, geo.ground, 0);
    const c = geo.iso(0, i, 0);
    const d = geo.iso(geo.ground, i, 0);
    const opacity = Number.isInteger(i) ? 1 : 0.45;
    lines.push(<line key={`a${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeOpacity={opacity} />);
    lines.push(<line key={`b${i}`} x1={c[0]} y1={c[1]} x2={d[0]} y2={d[1]} strokeOpacity={opacity} />);
  }
  return <g className="adecd-grid">{lines}</g>;
}

function footOf(item: Placed) {
  const w = item.w / 2;
  return { x0: item.cx - w, y0: item.cy - w, x1: item.cx + w, y1: item.cy + w };
}

function SelectionRing({ item, geo, on }: { item: Placed; geo: Geometry; on: boolean }) {
  const f = footOf(item);
  const m = 0.22;
  return (
    <polygon
      className="adecd-selring"
      data-on={on ? "1" : "0"}
      points={pts([geo.iso(f.x0 - m, f.y0 - m, 0), geo.iso(f.x1 + m, f.y0 - m, 0), geo.iso(f.x1 + m, f.y1 + m, 0), geo.iso(f.x0 - m, f.y1 + m, 0)])}
    />
  );
}

/** A 0..1 tween on an event (rise or sink); it stops itself and leaves nothing running. */
function useTween(run: "rise" | "sink" | null, onEnd: () => void): number {
  const [k, setK] = useState(run === "rise" ? 0 : 1);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    if (!run) return;
    const from = run === "rise" ? 0 : 1;
    const to = run === "rise" ? 1 : 0;
    const ms = run === "rise" ? RISE_MS : SINK_MS;
    const start = performance.now();
    let frame = 0;
    const step = (at: number) => {
      const t = Math.min(1, (at - start) / ms);
      const eased = run === "rise" ? 1 - (1 - t) ** 3 : t * t * t;
      setK(from + (to - from) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
      else endRef.current();
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [run]);
  return run ? k : 1;
}

const Block = memo(function Block({
  domId,
  defs,
  item,
  geo,
  selected,
  entering,
  leaving,
  animate,
  labels,
  onDone,
  onHover,
  onSelect,
  onOpen,
}: {
  labels: boolean;
  domId: string;
  defs: string;
  item: Placed;
  geo: Geometry;
  selected: boolean;
  entering: boolean;
  leaving: boolean;
  animate: boolean;
  onDone: (key: string) => void;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  onOpen?: (key: string) => void;
}) {
  const run = !animate ? null : leaving ? "sink" : entering ? "rise" : null;
  const k = useTween(run, () => onDone(item.key));
  // Without motion, a removed block goes at once.
  useEffect(() => {
    if (leaving && !animate) onDone(item.key);
  }, [leaving, animate, item.key, onDone]);
  const iso = geo.iso;
  const f = footOf(item);
  const h = item.empty ? 0 : Math.max(0, item.size * geo.scale * k);
  const c0 = iso(item.cx, item.cy, 0);
  const label = labelFor(item, geo, h);

  let body: ReactNode = null;
  if (item.empty) {
    const corners: Array<[number, number]> = [[f.x1, f.y1], [f.x0, f.y1], [f.x1, f.y0]];
    body = (
      <g className="adecd-plot-empty">
        <polygon points={pts([iso(f.x0, f.y0, 0), iso(f.x1, f.y0, 0), iso(f.x1, f.y1, 0), iso(f.x0, f.y1, 0)])} />
        {corners.map(([x, y]) => {
          const a = iso(x, y, 0);
          const b = iso(x, y, 26);
          return <line key={`${x}-${y}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />;
        })}
      </g>
    );
  } else if (h >= 0.6) {
    const left: Pt[] = [iso(f.x0, f.y1, 0), iso(f.x1, f.y1, 0), iso(f.x1, f.y1, h), iso(f.x0, f.y1, h)];
    const right: Pt[] = [iso(f.x1, f.y0, 0), iso(f.x1, f.y1, 0), iso(f.x1, f.y1, h), iso(f.x1, f.y0, h)];
    const roof: Pt[] = [iso(f.x0, f.y0, h), iso(f.x1, f.y0, h), iso(f.x1, f.y1, h), iso(f.x0, f.y1, h)];
    const e = 0.075;
    const inner: Pt[] = [iso(f.x0 + e, f.y0 + e, h), iso(f.x1 - e, f.y0 + e, h), iso(f.x1 - e, f.y1 - e, h), iso(f.x0 + e, f.y1 - e, h)];
    const windows: ReactNode[] = [];
    const bloom: ReactNode[] = [];
    const floorStep = 12 * (geo.unit / UNIT);
    const floorH = 6 * (geo.unit / UNIT);
    const cols = Math.max(2, Math.round(item.w / 0.31));
    const cw = item.w / cols;
    let floor = 0;
    for (let z = 8; z + floorH <= h - floorH; z += floorStep, floor += 1) {
      for (let face = 0; face < 2; face += 1) {
        for (let col = 0; col < cols; col += 1) {
          const r1 = hash(item.seed, face, floor, col);
          const r2 = hash(item.seed + 7, face, floor, col);
          const lit = r1 < 0.56 ? (r1 < 0.07 ? 2 : 1) : 0;
          const u0 = (face === 0 ? f.x0 : f.y0) + (col + 0.24) * cw;
          const u1 = (face === 0 ? f.x0 : f.y0) + (col + 0.76) * cw;
          const p = face === 0
            ? pts([iso(u0, f.y1, z), iso(u1, f.y1, z), iso(u1, f.y1, z + floorH), iso(u0, f.y1, z + floorH)])
            : pts([iso(f.x1, u0, z), iso(f.x1, u1, z), iso(f.x1, u1, z + floorH), iso(f.x1, u0, z + floorH)]);
          windows.push(
            <polygon
              key={`${face}-${floor}-${col}`}
              className="adecd-w"
              data-c={lit}
              data-n={r2 < 0.05 ? 1 : 0}
              style={{ transitionDelay: `${Math.round(hash(item.seed + 3, face, floor, col) * 520)}ms` }}
              points={p}
            />,
          );
          if (lit) bloom.push(<polygon key={`b-${face}-${floor}-${col}`} points={p} />);
        }
      }
    }
    const corner0 = iso(f.x1, f.y1, 0);
    const cornerH = iso(f.x1, f.y1, h);
    const shade: Pt[] = [iso(f.x0, f.y1, 0), iso(f.x1, f.y1, 0), iso(f.x1, f.y0, 0), iso(f.x1, f.y0, h), iso(f.x0, f.y0, h), iso(f.x0, f.y1, h)];
    const tall = h > 30 * (geo.unit / UNIT);
    body = (
      <>
        <polygon points={pts(left)} fill={`url(#${defs}-fl)`} />
        <polygon points={pts(right)} fill={`url(#${defs}-fr)`} />
        <polygon points={pts(roof)} fill={`url(#${defs}-roof)`} />
        <polygon points={pts(inner)} fill="#000" fillOpacity=".13" />
        <g className="adecd-bloom" filter={`url(#${defs}-bloom)`}>{bloom}</g>
        {windows}
        <polyline className="adecd-rim" points={pts([iso(f.x0, f.y1, h), iso(f.x1, f.y1, h), iso(f.x1, f.y0, h)])} strokeOpacity=".6" strokeWidth="1" />
        <polyline className="adecd-rim" points={pts([iso(f.x0, f.y1, h), iso(f.x0, f.y0, h), iso(f.x1, f.y0, h)])} strokeOpacity=".22" strokeWidth=".8" />
        <line className="adecd-edge" x1={corner0[0]} y1={corner0[1]} x2={cornerH[0]} y2={cornerH[1]} />
        <polygon className="adecd-shade" points={pts(shade)} />
        {item.rank >= 2 && tall ? <RoofRoom f={f} h={h} geo={geo} defs={defs} /> : null}
        {item.rank >= 3 && tall ? <Antenna f={f} h={h} geo={geo} /> : null}
        {item.old ? <OldFlag f={f} h={h} geo={geo} /> : null}
      </>
    );
  }

  return (
    <g
      id={domId}
      className="adecd-blk"
      role="option"
      aria-selected={selected}
      aria-label={item.aria}
      data-awake={item.awake && !item.empty ? "1" : "0"}
      data-old={item.old ? "1" : "0"}
      data-sel={selected ? "1" : "0"}
      onMouseEnter={() => onHover(item.key)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect(item.key)}
      onDoubleClick={() => onOpen?.(item.key)}
    >
      {item.empty ? null : (
        <g className="adecd-glow">
          <ellipse cx={c0[0]} cy={iso(item.cx, item.cy, h * 0.55)[1]} rx={item.w * geo.cx * 1.25 + 10} ry={h * 0.62 + 24} fill={`url(#${defs}-halo)`} />
          <ellipse cx={c0[0]} cy={c0[1]} rx={item.w * geo.cx * 1.9} ry={item.w * geo.cy * 1.9} fill={`url(#${defs}-glow)`} />
        </g>
      )}
      {/* The whole column answers the pointer, not only the painted faces. */}
      <polygon className="adecd-hit" points={pts([iso(f.x0, f.y1, 0), iso(f.x1, f.y1, 0), iso(f.x1, f.y0, 0), iso(f.x1, f.y0, Math.max(h, 26)), iso(f.x0, f.y0, Math.max(h, 26)), iso(f.x0, f.y1, Math.max(h, 26))])} />
      {body}
      {entering && animate ? <Puffs item={item} geo={geo} defs={defs} big /> : null}
      {leaving && animate ? <Puffs item={item} geo={geo} defs={defs} /> : null}
      {labels && label && k >= 0.98 ? (
        <g className="adecd-lbl" aria-hidden="true">
          <text x={label.x} y={label.y} dy="-1.25em" textAnchor={label.anchor} className="adecd-lbl-n">{item.name}</text>
          <text x={label.x} y={label.y} textAnchor={label.anchor} className="adecd-lbl-s">{item.sub}</text>
        </g>
      ) : null}
    </g>
  );
});

function labelFor(item: Placed, geo: Geometry, h: number): { x: number; y: number; anchor: "start" | "middle" | "end" } | null {
  if (!item.empty && h < 0.6) return null;
  const f = footOf(item);
  const top = geo.iso(f.x0, f.y0, item.empty ? 26 : h);
  const dx = geo.iso(item.cx, item.cy, 0)[0] - geo.ox;
  const anchor = dx > 30 ? "start" : dx < -30 ? "end" : "middle";
  return { x: anchor === "start" ? top[0] - 6 : anchor === "end" ? top[0] + 6 : top[0], y: top[1] - 9, anchor };
}

function RoofRoom({ f, h, geo, defs }: { f: ReturnType<typeof footOf>; h: number; geo: Geometry; defs: string }) {
  const q = 0.32;
  const bx = f.x0 + 0.18;
  const by = f.y0 + 0.18;
  const bh = 7 * (geo.unit / UNIT);
  const iso = geo.iso;
  return (
    <g className="adecd-ru">
      <polygon points={pts([iso(bx, by + q, h), iso(bx + q, by + q, h), iso(bx + q, by + q, h + bh), iso(bx, by + q, h + bh)])} fill={`url(#${defs}-fl)`} />
      <polygon points={pts([iso(bx + q, by, h), iso(bx + q, by + q, h), iso(bx + q, by + q, h + bh), iso(bx + q, by, h + bh)])} fill={`url(#${defs}-fr)`} />
      <polygon points={pts([iso(bx, by, h + bh), iso(bx + q, by, h + bh), iso(bx + q, by + q, h + bh), iso(bx, by + q, h + bh)])} fill={`url(#${defs}-roof)`} />
    </g>
  );
}

function Antenna({ f, h, geo }: { f: ReturnType<typeof footOf>; h: number; geo: Geometry }) {
  const base = geo.iso(f.x1 - 0.35, f.y1 - 0.35, h);
  const tall = 18 * (geo.unit / UNIT);
  return (
    <>
      <line className="adecd-rim" x1={base[0]} y1={base[1]} x2={base[0]} y2={base[1] - tall} strokeOpacity=".7" strokeWidth="1" />
      <circle className="adecd-ant" cx={base[0]} cy={base[1] - tall - 0.5} r="1.8" />
    </>
  );
}

/** Not used for a long time: an amber pennant on the roof. */
function OldFlag({ f, h, geo }: { f: ReturnType<typeof footOf>; h: number; geo: Geometry }) {
  const base = geo.iso(f.x0 + 0.3, f.y0 + 0.3, h);
  const tall = 16 * (geo.unit / UNIT);
  return (
    <g className="adecd-flag">
      <line x1={base[0]} y1={base[1]} x2={base[0]} y2={base[1] - tall} strokeWidth="1" />
      <path d={`M${base[0].toFixed(1)} ${(base[1] - tall).toFixed(1)}l9 2.6-9 2.6z`} />
    </g>
  );
}

/** A short drift of cloud around a block that rises or sinks. One-shot CSS; gone with the block's state. */
function Puffs({ item, geo, defs, big = false }: { item: Placed; geo: Geometry; defs: string; big?: boolean }) {
  const count = big ? 7 : 5;
  const puffs: ReactNode[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + 0.4;
    const r = item.w * 0.55;
    const p = geo.iso(item.cx + Math.cos(angle) * r, item.cy + Math.sin(angle) * r, 2 + (i % 3) * 5);
    const rx = 20 + (i % 3) * 7;
    puffs.push(
      <ellipse
        key={i}
        cx={p[0]}
        cy={p[1]}
        rx={rx}
        ry={rx * 0.5}
        fill={`url(#${defs}-puff)`}
        style={{ ["--dx" as string]: `${Math.round(Math.cos(angle) * 22 + (i % 2 ? 10 : -6))}px`, ["--dy" as string]: `${-14 - (i % 3) * 8}px`, animationDelay: `${i * 70}ms` }}
      />,
    );
  }
  return <g className="adecd-puffs" aria-hidden="true">{puffs}</g>;
}

/** The hover readout above the active block, placed in the stage's own coordinates. */
function Readout({ item, geo, viewH, lifted }: { item: Placed; geo: Geometry; viewH: number; lifted: boolean }) {
  const f = footOf(item);
  const h = item.empty ? 26 : item.size * geo.scale;
  const top = geo.iso(f.x0, f.y0, h);
  const left = (geo.iso(item.cx, item.cy, 0)[0] / VIEW_W) * 100;
  const y = Math.max(0, ((top[1] - 40 - (lifted ? 6 : 0)) / viewH) * 100);
  return (
    <div className="adecd-readout" style={{ left: `${left}%`, top: `${y}%` }} aria-hidden="true">
      <b>{item.name}</b>
      {item.detail.map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}
