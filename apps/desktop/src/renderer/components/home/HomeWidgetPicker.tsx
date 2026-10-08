import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle, MagnifyingGlass, Plus, SquaresFour, Warning } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";
import { HomeRenderWidgetContext } from "./homeData";
import { layoutCells, useHomeLayoutStore, type HomeLayoutCell, type HomeWidgetSize, type HomeWidgetType } from "./homeLayout";
import {
  HOME_CLASS_LABEL,
  HOME_GALLERY_ORDER,
  HOME_WIDGET_CATALOG,
  HOME_WIDGET_CATEGORIES,
  widgetShape,
  type HomeWidgetCategory,
} from "./homeWidgetCatalog";
import {
  GRID_GAP,
  classSpan,
  itemSizeClass,
  packLayout,
  shapeClasses,
  storedSizeFor,
  type GridMetrics,
  type HomeSizeClass,
  type Span,
} from "./homeGridPack";
import { WidgetPreviewContext, useHomeGridMetrics } from "./HomeWidgetGrid";
import "./homeWidgets.css";

/**
 * The Add widget gallery. Every widget is shown live (the real component,
 * scaled down, inert, with nothing switched on), grouped by category and
 * searchable. Picking one opens it at each size class it offers, says
 * whether it fits on the page as it is (the same layout engine the page
 * uses), and when it does not, offers to make room by setting other widgets
 * to Compact, or to replace one.
 */

const FALLBACK_METRICS: GridMetrics = { columns: 3, maxRows: 3, width: 1120, height: 640 };

function cellPx(metrics: GridMetrics) {
  const colW = (metrics.width - (metrics.columns - 1) * GRID_GAP) / metrics.columns;
  // Previews read at the row height the default two-row page has.
  const rowH = Math.max(200, Math.min(320, (metrics.height - GRID_GAP) / 2));
  return { colW, rowH };
}

function spanPx(span: Span, metrics: GridMetrics) {
  const { colW, rowH } = cellPx(metrics);
  return { width: span.w * colW + (span.w - 1) * GRID_GAP, height: span.h * rowH + (span.h - 1) * GRID_GAP };
}

function storedSize(type: HomeWidgetType, cls: HomeSizeClass): HomeWidgetSize {
  return storedSizeFor(cls, widgetShape(type));
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
function FluidPreview(props: { type: HomeWidgetType; cls: HomeSizeClass; metrics: GridMetrics; stageHeight: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const width = useWidth(ref, 260);
  return <div ref={ref} className="ade-picker-fluid">{width > 0 ? <LivePreview {...props} stageWidth={width} /> : null}</div>;
}

/** The real widget at a span, scaled into a stage. */
function LivePreview({ type, cls, metrics, stageWidth, stageHeight }: { type: HomeWidgetType; cls: HomeSizeClass; metrics: GridMetrics; stageWidth: number; stageHeight: number }) {
  const renderWidget = useContext(HomeRenderWidgetContext);
  const span = classSpan(widgetShape(type), cls, metrics.columns);
  const size = storedSize(type, cls);
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

/** A class's shape as a tiny cell diagram, the way a widget gallery shows it. */
function SizeGlyph({ span }: { span: Span }) {
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
  | { kind: "shrink"; shrink: Array<{ id: string; size: HomeWidgetSize; title: string }> }
  | { kind: "full" };

/**
 * Whether a widget fits at a class as the page is (nothing else hidden or
 * squeezed), or after setting others to Compact, largest first.
 */
function planAdd(cells: readonly HomeLayoutCell[], type: HomeWidgetType, cls: HomeSizeClass, metrics: GridMetrics): AddPlan {
  const probe: HomeLayoutCell = { host: { id: "__new", type, size: storedSize(type, cls) }, stacked: [] };
  const before = packLayout(cells, metrics, widgetShape);
  const fits = (list: readonly HomeLayoutCell[]) => {
    const result = packLayout([...list, probe], metrics, widgetShape);
    const placed = result.placed.find((entry) => entry.cell.host.id === "__new");
    return placed != null && placed.cls === cls && result.hidden.length <= before.hidden.length && result.shrunk <= before.shrunk;
  };
  if (fits(cells)) return { kind: "fits" };
  const area = (cell: HomeLayoutCell) => {
    const shape = widgetShape(cell.host.type);
    const span = classSpan(shape, itemSizeClass(cell.host, shape));
    return span.w * span.h;
  };
  let working = [...cells];
  const shrink: Array<{ id: string; size: HomeWidgetSize; title: string }> = [];
  for (const cell of [...cells].sort((a, b) => area(b) - area(a))) {
    const shape = widgetShape(cell.host.type);
    if (!shape.classes.compact || itemSizeClass(cell.host, shape) === "compact") continue;
    const size = storedSizeFor("compact", shape);
    working = working.map((entry) => (entry.host.id === cell.host.id ? { ...entry, host: { ...entry.host, size } } : entry));
    shrink.push({ id: cell.host.id, size, title: HOME_WIDGET_CATALOG[cell.host.type].title });
    if (fits(working)) return { kind: "shrink", shrink };
  }
  return { kind: "full" };
}

/**
 * The class a gallery tile shows: one row tall, so a tall widget (the feed)
 * is not shrunk to an unreadable sliver in a short tile. The detail view
 * still shows every class.
 */
function tileClass(type: HomeWidgetType): HomeSizeClass {
  const meta = HOME_WIDGET_CATALOG[type];
  const shape = widgetShape(type);
  const oneRow = (cls: HomeSizeClass) => Boolean(shape.classes[cls]) && classSpan(shape, cls).h === 1;
  if (oneRow(meta.defaultClass)) return meta.defaultClass;
  return (["regular", "compact", "large"] as const).find(oneRow) ?? meta.defaultClass;
}

function PickerTile({ type, present, metrics, onOpen }: { type: HomeWidgetType; present: boolean; metrics: GridMetrics; onOpen: () => void }) {
  const meta = HOME_WIDGET_CATALOG[type];
  const Icon = meta.icon;
  const unavailable = meta.comingSoon ?? (meta.desktopOnly && !window.ade?.home ? "Needs the ADE desktop app." : null);
  // The live preview renders the widget's own buttons, so the tile is not a
  // button: its title is, stretched over the whole tile (CSS).
  return (
    <div className="ade-picker-tile" data-present={present || undefined} data-unavailable={unavailable ? "true" : undefined}>
      <FluidPreview type={type} cls={tileClass(type)} metrics={metrics} stageHeight={176} />
      <button type="button" className="ade-picker-tile-text" onClick={onOpen}>
        <span className="ade-picker-tile-title">
          <Icon size={13} aria-hidden />
          {meta.title}
          {present ? <span className="ade-picker-state" data-tone="ok"><CheckCircle size={11} weight="fill" /> On page</span> : null}
        </span>
        <span className="ade-picker-tile-desc">{unavailable ?? meta.description}</span>
      </button>
    </div>
  );
}

function PickerDetail({ type, metrics, onBack, onAdded }: { type: HomeWidgetType; metrics: GridMetrics; onBack: () => void; onAdded: () => void }) {
  const meta = HOME_WIDGET_CATALOG[type];
  const items = useHomeLayoutStore((s) => s.layout.items);
  const add = useHomeLayoutStore((s) => s.add);
  const shape = widgetShape(type);
  const classes = shapeClasses(shape);
  const [cls, setCls] = useState<HomeSizeClass>(classes.includes(meta.defaultClass) ? meta.defaultClass : classes[0] ?? "compact");
  const [replaceId, setReplaceId] = useState<string>("");
  const cells = useMemo(() => layoutCells(items), [items]);
  const plan = useMemo(() => planAdd(cells, type, cls, metrics), [cells, cls, metrics, type]);
  const size = storedSize(type, cls);
  const present = items.some((item) => item.type === type);
  const unavailable = meta.comingSoon ?? (meta.desktopOnly && !window.ade?.home ? "Needs the ADE desktop app." : null);
  const span = classSpan(shape, cls, metrics.columns);
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
      <button type="button" className="kit-btn kit-btn-primary" onClick={() => { add(type, size); onAdded(); }}>
        <Plus size={12} weight="bold" aria-hidden /> Add widget
      </button>
    );
  } else if (plan.kind === "shrink") {
    status = (
      <span className="ade-picker-fit" data-tone="warn">
        <Warning size={13} weight="fill" /> No room yet. Make room by setting {plan.shrink.map((entry) => entry.title).join(", ")} to Compact.
      </span>
    );
    action = (
      <button type="button" className="kit-btn kit-btn-primary" onClick={() => { add(type, size, { shrink: plan.shrink }); onAdded(); }}>
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
        <button type="button" className="kit-btn kit-btn-primary" disabled={!replaceId} onClick={() => { add(type, size, { replaceId }); onAdded(); }}>
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
        <LivePreview key={cls} type={type} cls={cls} metrics={metrics} stageWidth={stage.width} stageHeight={stage.height} />
      </div>
      <div className="ade-picker-sizes" role="radiogroup" aria-label="Size">
        {classes.map((option) => {
          const optionSpan = classSpan(shape, option, metrics.columns);
          return (
            <button key={option} type="button" role="radio" aria-checked={cls === option} onClick={() => setCls(option)} className="ade-picker-size">
              <SizeGlyph span={optionSpan} />
              <span>{HOME_CLASS_LABEL[option].long}</span>
              <span className="kit-num">{optionSpan.w} × {optionSpan.h}</span>
            </button>
          );
        })}
      </div>
      <p className="ade-picker-size-note">The page gives it more room when there is some to spare.</p>
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
            <span>{metrics.columns} columns · up to {metrics.maxRows} rows · fills itself</span>
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
