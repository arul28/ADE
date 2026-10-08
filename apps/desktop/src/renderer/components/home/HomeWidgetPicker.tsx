import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle, MagnifyingGlass, Plus, SquaresFour, Warning } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";
import { HomeRenderWidgetContext } from "./homeData";
import { layoutCells, useHomeLayoutStore, type HomeLayoutCell, type HomeWidgetSize, type HomeWidgetType } from "./homeLayout";
import {
  HOME_GALLERY_ORDER,
  HOME_SIZE_LABEL,
  HOME_WIDGET_CATALOG,
  HOME_WIDGET_CATEGORIES,
  widgetLimits,
  type HomeWidgetCategory,
} from "./homeWidgetCatalog";
import { GRID_GAP, itemSpan, packLayout, spanFromSize, type GridMetrics } from "./homeGridPack";
import { WidgetPreviewContext, useHomeGridMetrics } from "./HomeWidgetGrid";
import "./homeWidgets.css";

/**
 * The Add widget gallery. Every widget is shown live (the real component,
 * scaled down, inert, with nothing switched on), grouped by category and
 * searchable. Picking one opens it at each size it allows, says whether it
 * fits on the page as it is, and when it does not, offers to make room by
 * shrinking other widgets or to replace one.
 */

const FALLBACK_METRICS: GridMetrics = { columns: 3, maxRows: 3, width: 1120, height: 640 };

function cellPx(metrics: GridMetrics) {
  const colW = (metrics.width - (metrics.columns - 1) * GRID_GAP) / metrics.columns;
  // Previews read at the row height the default two-row page has.
  const rowH = Math.max(200, Math.min(320, (metrics.height - GRID_GAP) / 2));
  return { colW, rowH };
}

function spanPx(span: { w: number; h: number }, metrics: GridMetrics) {
  const { colW, rowH } = cellPx(metrics);
  return { width: span.w * colW + (span.w - 1) * GRID_GAP, height: span.h * rowH + (span.h - 1) * GRID_GAP };
}

function allowedSizes(type: HomeWidgetType): HomeWidgetSize[] {
  const limits = HOME_WIDGET_CATALOG[type].limits;
  return (["s", "m", "w", "l"] as HomeWidgetSize[]).filter((size) => {
    const span = spanFromSize(size);
    return span.w >= limits.minW && span.w <= limits.maxW && span.h >= limits.minH && span.h <= limits.maxH;
  });
}

/** The width an element gets from its layout. */
function useWidth(ref: React.RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0]?.contentRect.width ?? fallback)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback, ref]);
  return width;
}

/** A stage as wide as its slot. */
function FluidPreview(props: { type: HomeWidgetType; size: HomeWidgetSize; metrics: GridMetrics; stageHeight: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const width = useWidth(ref, 260);
  return <div ref={ref} className="ade-picker-fluid">{width > 0 ? <LivePreview {...props} stageWidth={width} /> : null}</div>;
}

/** The real widget at a span, scaled into a stage. */
function LivePreview({ type, size, metrics, stageWidth, stageHeight }: { type: HomeWidgetType; size: HomeWidgetSize; metrics: GridMetrics; stageWidth: number; stageHeight: number }) {
  const renderWidget = useContext(HomeRenderWidgetContext);
  const span = spanFromSize(size);
  const px = spanPx(span, metrics);
  // Leave a margin so the card floats on its stage, as on the page.
  const scale = Math.min(1, (stageWidth - 24) / px.width, (stageHeight - 20) / px.height);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = ref.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (element) element.inert = true;
  }, []);
  if (!renderWidget) return null;
  return (
    <div className="ade-picker-stage" style={{ width: stageWidth, height: stageHeight }}>
      <div style={{ width: px.width * scale, height: px.height * scale }} className="ade-picker-stage-fit">
        <div
          ref={ref}
          className="ade-picker-live"
          aria-hidden
          style={{ width: px.width, height: px.height, transform: `scale(${scale})` }}
        >
          <WidgetPreviewContext.Provider value>
            {renderWidget({ item: { id: `preview-${type}-${size}`, type, size }, stacked: false, editing: false, preview: true })}
          </WidgetPreviewContext.Provider>
        </div>
      </div>
    </div>
  );
}

/** Size as a tiny cell diagram, the way a widget gallery shows it. */
function SizeGlyph({ size }: { size: HomeWidgetSize }) {
  const span = spanFromSize(size);
  return (
    <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden className="ade-picker-size-glyph">
      {[0, 1].map((row) => [0, 1].map((col) => (
        <rect
          key={`${row}-${col}`}
          x={1 + col * 11}
          y={1 + row * 11}
          width="9"
          height="9"
          rx="2"
          data-on={col < span.w && row < span.h ? "true" : undefined}
        />
      )))}
    </svg>
  );
}

type AddPlan =
  | { kind: "fits" }
  | { kind: "shrink"; shrink: Array<{ id: string; w: number; h: number; title: string }> }
  | { kind: "full" };

/** Whether a widget fits as the page is, or after shrinking others to their smallest. */
function planAdd(cells: readonly HomeLayoutCell[], type: HomeWidgetType, size: HomeWidgetSize, metrics: GridMetrics): AddPlan {
  const span = spanFromSize(size);
  const probe: HomeLayoutCell = { host: { id: "__new", type, size, w: span.w, h: span.h }, stacked: [] };
  const hiddenBefore = packLayout(cells, metrics, widgetLimits).hidden.length;
  const fits = (list: readonly HomeLayoutCell[]) => {
    const result = packLayout([...list, probe], metrics, widgetLimits);
    return !result.hidden.some((cell) => cell.host.id === "__new") && result.hidden.length <= hiddenBefore;
  };
  if (fits(cells)) return { kind: "fits" };
  const order = [...cells].sort((a, b) => {
    const sa = itemSpan(a.host);
    const sb = itemSpan(b.host);
    return sb.w * sb.h - sa.w * sa.h;
  });
  let working = [...cells];
  const shrink: Array<{ id: string; w: number; h: number; title: string }> = [];
  for (const cell of order) {
    const limits = HOME_WIDGET_CATALOG[cell.host.type].limits;
    const current = itemSpan(cell.host);
    const next = { w: limits.minW, h: limits.minH };
    if (next.w >= current.w && next.h >= current.h) continue;
    working = working.map((entry) => (entry.host.id === cell.host.id ? { ...entry, host: { ...entry.host, ...next } } : entry));
    shrink.push({ id: cell.host.id, ...next, title: HOME_WIDGET_CATALOG[cell.host.type].title });
    if (fits(working)) return { kind: "shrink", shrink };
  }
  return { kind: "full" };
}

function PickerTile({ type, present, metrics, onOpen }: { type: HomeWidgetType; present: boolean; metrics: GridMetrics; onOpen: () => void }) {
  const meta = HOME_WIDGET_CATALOG[type];
  const Icon = meta.icon;
  const unavailable = meta.comingSoon ?? (meta.desktopOnly && !window.ade?.home ? "Needs the ADE desktop app." : null);
  return (
    <button type="button" className="ade-picker-tile" onClick={onOpen} data-present={present || undefined} data-unavailable={unavailable ? "true" : undefined}>
      <FluidPreview type={type} size={meta.defaultSize} metrics={metrics} stageHeight={168} />
      <span className="ade-picker-tile-text">
        <span className="ade-picker-tile-title">
          <Icon size={13} aria-hidden />
          {meta.title}
          {present ? <span className="ade-picker-state" data-tone="ok"><CheckCircle size={11} weight="fill" /> On page</span> : null}
        </span>
        <span className="ade-picker-tile-desc">{unavailable ?? meta.description}</span>
      </span>
    </button>
  );
}

function PickerDetail({ type, metrics, onBack, onAdded }: { type: HomeWidgetType; metrics: GridMetrics; onBack: () => void; onAdded: () => void }) {
  const meta = HOME_WIDGET_CATALOG[type];
  const items = useHomeLayoutStore((s) => s.layout.items);
  const add = useHomeLayoutStore((s) => s.add);
  const sizes = allowedSizes(type);
  const [size, setSize] = useState<HomeWidgetSize>(sizes.includes(meta.defaultSize) ? meta.defaultSize : sizes[0] ?? "s");
  const [replaceId, setReplaceId] = useState<string>("");
  const cells = useMemo(() => layoutCells(items), [items]);
  const plan = useMemo(() => planAdd(cells, type, size, metrics), [cells, metrics, size, type]);
  const present = items.some((item) => item.type === type);
  const unavailable = meta.comingSoon ?? (meta.desktopOnly && !window.ade?.home ? "Needs the ADE desktop app." : null);
  const span = spanFromSize(size);
  const Icon = meta.icon;

  let status: ReactNode;
  let action: ReactNode;
  if (unavailable) {
    status = <span className="ade-picker-fit" data-tone="muted">{unavailable}</span>;
    action = null;
  } else if (present) {
    status = <span className="ade-picker-fit" data-tone="ok"><CheckCircle size={13} weight="fill" /> Already on your page</span>;
    action = null;
  } else if (plan.kind === "fits") {
    status = <span className="ade-picker-fit" data-tone="ok"><CheckCircle size={13} weight="fill" /> Fits on your page</span>;
    action = (
      <button type="button" className="kit-btn kit-btn-primary" onClick={() => { add(type, size, { span }); onAdded(); }}>
        <Plus size={12} weight="bold" aria-hidden /> Add widget
      </button>
    );
  } else if (plan.kind === "shrink") {
    status = (
      <span className="ade-picker-fit" data-tone="warn">
        <Warning size={13} weight="fill" /> No room yet. Make room by shrinking {plan.shrink.map((entry) => entry.title).join(", ")}.
      </span>
    );
    action = (
      <button type="button" className="kit-btn kit-btn-primary" onClick={() => { add(type, size, { span, shrink: plan.shrink }); onAdded(); }}>
        Make room and add
      </button>
    );
  } else {
    status = <span className="ade-picker-fit" data-tone="warn"><Warning size={13} weight="fill" /> No room on this page. Replace a widget, or pick a smaller size.</span>;
    action = (
      <span className="ade-picker-replace">
        <select className="ade-picker-select" value={replaceId} onChange={(event) => setReplaceId(event.target.value)} aria-label="Widget to replace">
          <option value="">Replace…</option>
          {cells.map((cell) => (
            <option key={cell.host.id} value={cell.host.id}>{HOME_WIDGET_CATALOG[cell.host.type].title}</option>
          ))}
        </select>
        <button type="button" className="kit-btn kit-btn-primary" disabled={!replaceId} onClick={() => { add(type, size, { span, replaceId }); onAdded(); }}>
          Replace
        </button>
      </span>
    );
  }

  const stage = useMemo(() => {
    const px = spanPx(span, metrics);
    return { width: Math.min(560, px.width), height: Math.min(340, px.height) };
  }, [metrics, span]);

  return (
    <div className="ade-picker-detail">
      <div className="ade-picker-detail-head">
        <button type="button" className="kit-icon-btn" aria-label="Back to all widgets" onClick={onBack}><ArrowLeft size={14} /></button>
        <Icon size={16} aria-hidden />
        <div className="ade-picker-detail-title">
          <strong>{meta.title}</strong>
          <span>{meta.description}</span>
        </div>
      </div>
      <div className="ade-picker-detail-stage">
        <LivePreview key={size} type={type} size={size} metrics={metrics} stageWidth={stage.width} stageHeight={stage.height} />
      </div>
      <div className="ade-picker-sizes" role="radiogroup" aria-label="Size">
        {sizes.map((option) => (
          <button key={option} type="button" role="radio" aria-checked={size === option} onClick={() => setSize(option)} className="ade-picker-size">
            <SizeGlyph size={option} />
            <span>{HOME_SIZE_LABEL[option].long.split(" · ")[0]}</span>
            <span className="kit-num">{spanFromSize(option).w} × {spanFromSize(option).h}</span>
          </button>
        ))}
      </div>
      <div className="ade-picker-detail-foot">
        {status}
        {action}
      </div>
    </div>
  );
}

export default function HomeWidgetPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const items = useHomeLayoutStore((s) => s.layout.items);
  const metrics = useHomeGridMetrics((s) => s.metrics) ?? FALLBACK_METRICS;
  const [category, setCategory] = useState<HomeWidgetCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<HomeWidgetType | null>(null);
  const onPage = useMemo(() => new Set(items.map((item) => item.type)), [items]);
  useEffect(() => {
    if (!open) {
      setSelected(null);
      setQuery("");
    }
  }, [open]);
  const needle = query.trim().toLowerCase();
  const visible = HOME_GALLERY_ORDER.filter((type) => {
    const meta = HOME_WIDGET_CATALOG[type];
    if (category !== "all" && meta.category !== category) return false;
    return !needle || `${meta.title} ${meta.description}`.toLowerCase().includes(needle);
  });
  const counts = useMemo(() => {
    const map = new Map<HomeWidgetCategory, number>();
    for (const type of HOME_GALLERY_ORDER) map.set(HOME_WIDGET_CATALOG[type].category, (map.get(HOME_WIDGET_CATALOG[type].category) ?? 0) + 1);
    return map;
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a widget"
      hideHeader
      width={980}
      height="min(680px, 86vh)"
      bodyPadding={false}
      scrollBody={false}
      panelClassName="ade-picker-panel"
    >
      <div className="ade-picker">
        <aside className="ade-picker-rail">
          <div className="ade-picker-search">
            <MagnifyingGlass size={13} aria-hidden />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(null);
              }}
              placeholder="Search widgets"
              aria-label="Search widgets"
            />
          </div>
          <nav className="ade-picker-cats" aria-label="Categories">
            <button type="button" aria-current={category === "all" ? "true" : undefined} onClick={() => { setCategory("all"); setSelected(null); }}>
              <SquaresFour size={14} aria-hidden /> All widgets <span className="kit-num">{HOME_GALLERY_ORDER.length}</span>
            </button>
            {HOME_WIDGET_CATEGORIES.map((entry) => (
              <button key={entry.id} type="button" aria-current={category === entry.id ? "true" : undefined} onClick={() => { setCategory(entry.id); setSelected(null); }}>
                <span className="ade-picker-cat-dot" data-cat={entry.id} aria-hidden />
                {entry.label}
                <span className="kit-num">{counts.get(entry.id) ?? 0}</span>
              </button>
            ))}
          </nav>
          <div className="ade-picker-rail-foot">
            <span className="kit-eyebrow">Your page</span>
            <span>{metrics.columns} columns · up to {metrics.maxRows} rows</span>
            <span>{items.length} widget{items.length === 1 ? "" : "s"}</span>
          </div>
        </aside>
        <section className="ade-picker-main">
          {selected ? (
            <PickerDetail
              type={selected}
              metrics={metrics}
              onBack={() => setSelected(null)}
              onAdded={() => {
                setSelected(null);
                onOpenChange(false);
              }}
            />
          ) : (
            <>
              <header className="ade-picker-main-head">
                <h2>{category === "all" ? "All widgets" : HOME_WIDGET_CATEGORIES.find((entry) => entry.id === category)?.label}</h2>
                <span>Pick one to see its sizes and where it goes.</span>
              </header>
              {visible.length === 0 ? (
                <div className="ade-home-empty"><span>No widget matches "{query}".</span></div>
              ) : (
                <div className="ade-picker-grid">
                  {visible.map((type) => (
                    <PickerTile key={type} type={type} present={onPage.has(type)} metrics={metrics} onOpen={() => setSelected(type)} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
