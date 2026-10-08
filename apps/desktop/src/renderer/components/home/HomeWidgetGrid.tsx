import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { create } from "zustand";
import { ArrowsInLineVertical, DotsSixVertical, EyeSlash, Stack, X } from "@phosphor-icons/react";
import {
  layoutCells,
  useHomeLayoutStore,
  type HomeLayoutCell,
  type HomeLayoutItem,
  type HomeWidgetSize,
} from "./homeLayout";
import { HOME_SIZE_LABEL, HOME_WIDGET_CATALOG, widgetLimits } from "./homeWidgetCatalog";
import { GRID_GAP, clampSpan, gridMetrics, itemSpan, packLayout, sizeClass, spanFromSize, type GridMetrics, type PackResult } from "./homeGridPack";
import { WelcomeCardHead } from "../projects/ProjectWelcomeSidePanels";

/**
 * The home page's grid. It never scrolls: its size comes from the window
 * (more columns on a wider window, as many rows as fit), widgets are packed
 * into it in layout order (`homeGridPack.ts`), and what has no room is hidden
 * behind a quiet "N hidden" note instead of overflowing.
 *
 * Edit mode turns every cell into a tile with its own controls: a handle
 * (drag, or arrow keys), the size presets the widget allows, stack or
 * unstack, remove, and a corner to drag-resize in whole cells within the
 * widget's limits. Widget content goes inert while editing so a drag never
 * opens a project by accident.
 */

const WIDGET_DRAG_TYPE = "application/x-ade-home-widget";

export type WidgetRenderContext = { item: HomeLayoutItem; stacked: boolean; editing: boolean; preview?: boolean };

/** True while the widget is on screen and the window is visible; widgets that poll pause otherwise. */
const WidgetVisibleContext = createContext(true);
export function useWidgetVisible(): boolean {
  return useContext(WidgetVisibleContext);
}

/**
 * True inside the Add widget gallery's previews: a widget renders as itself
 * but must not switch anything on (the clipboard watch) or take input.
 */
export const WidgetPreviewContext = createContext(false);
export function useWidgetPreview(): boolean {
  return useContext(WidgetPreviewContext);
}

/** The span the grid placed a widget at (it can grow taller than asked to fit its content). */
const WidgetSpanContext = createContext<{ w: number; h: number } | null>(null);
export function useWidgetSpan(item: HomeLayoutItem): { w: number; h: number } {
  return useContext(WidgetSpanContext) ?? itemSpan(item);
}

/** The live grid's size, for the gallery's "is there room?" check. */
export const useHomeGridMetrics = create<{ metrics: GridMetrics | null; set: (metrics: GridMetrics) => void }>((set) => ({
  metrics: null,
  set: (metrics) => set({ metrics }),
}));

function useVisibility(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)), { threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return inView && pageVisible;
}

class WidgetBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[home] widget failed", this.props.title, error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const meta = Object.values(HOME_WIDGET_CATALOG).find((entry) => entry.title === this.props.title);
    return (
      <section className="kit-card ade-home-card" aria-label={this.props.title}>
        {meta ? <WelcomeCardHead icon={meta.icon} title={this.props.title} /> : null}
        <div className="ade-home-empty" role="alert">
          <span>This widget stopped working.</span>
          <button type="button" className="kit-btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </section>
    );
  }
}

function WidgetFrame({
  item,
  stacked,
  editing,
  canStack,
  renderWidget,
  dragHandleProps,
  span,
}: {
  item: HomeLayoutItem;
  stacked: boolean;
  editing: boolean;
  canStack: boolean;
  renderWidget: (ctx: WidgetRenderContext) => ReactNode;
  dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  /** The span the grid placed this widget at (a host only). */
  span?: { w: number; h: number };
}) {
  const meta = HOME_WIDGET_CATALOG[item.type];
  const ref = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const visible = useVisibility(ref);
  const resize = useHomeLayoutStore((s) => s.resize);
  const remove = useHomeLayoutStore((s) => s.remove);
  const setStacked = useHomeLayoutStore((s) => s.setStacked);
  useEffect(() => {
    // React 18 has no `inert` prop; set it on the element.
    const element = contentRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (element) element.inert = editing;
  }, [editing]);
  const content = renderWidget({ item, stacked, editing });
  if (!editing && content == null) return null;
  const limits = meta.limits;
  const presets = (["s", "m", "w", "l"] as HomeWidgetSize[]).filter((size) => {
    const preset = spanFromSize(size);
    return preset.w >= limits.minW && preset.w <= limits.maxW && preset.h >= limits.minH && preset.h <= limits.maxH;
  });
  const current = span ? sizeClass(span.w, span.h) : item.size;
  const exactPreset = span ? presets.find((size) => {
    const preset = spanFromSize(size);
    return preset.w === span.w && preset.h === span.h;
  }) : item.size;
  return (
    <div ref={ref} className="ade-home-widget" data-stacked={stacked || undefined} data-type={item.type}>
      <div ref={contentRef} className="ade-home-widget-content">
        <WidgetVisibleContext.Provider value={visible}>
          <WidgetSpanContext.Provider value={stacked ? null : span ?? null}>
          <WidgetBoundary title={meta.title}>
            {content ?? (
              <section className="kit-card ade-home-card" aria-label={meta.title}>
                <WelcomeCardHead icon={meta.icon} title={meta.title} />
                <div className="ade-home-empty"><span>Hidden while empty.</span></div>
              </section>
            )}
          </WidgetBoundary>
          </WidgetSpanContext.Provider>
        </WidgetVisibleContext.Provider>
      </div>
      {editing ? (
        <div className="ade-home-edit-chrome" data-stacked={stacked || undefined}>
          {!stacked ? (
            <button
              type="button"
              className="ade-home-edit-btn ade-home-edit-handle"
              aria-label={`Move ${meta.title}. Use the arrow keys, or drag.`}
              title="Drag to move · arrow keys work too"
              {...dragHandleProps}
            >
              <DotsSixVertical size={14} weight="bold" />
            </button>
          ) : null}
          <span className="ade-home-edit-name">{meta.title}</span>
          {!stacked && presets.length > 1 ? (
            <div className="ade-home-edit-sizes" role="radiogroup" aria-label={`${meta.title} size`}>
              {presets.map((size) => (
                <button
                  key={size}
                  type="button"
                  role="radio"
                  aria-checked={exactPreset === size}
                  data-near={!exactPreset && current === size ? "true" : undefined}
                  title={HOME_SIZE_LABEL[size].long}
                  onClick={() => resize(item.id, size)}
                >
                  {HOME_SIZE_LABEL[size].short}
                </button>
              ))}
            </div>
          ) : null}
          {stacked ? (
            <button type="button" className="ade-home-edit-btn" title="Give it its own tile" aria-label={`Unstack ${meta.title}`} onClick={() => setStacked(item.id, false)}>
              <ArrowsInLineVertical size={14} />
            </button>
          ) : canStack ? (
            <button type="button" className="ade-home-edit-btn" title="Stack under the widget before it" aria-label={`Stack ${meta.title} under the widget before it`} onClick={() => setStacked(item.id, true)}>
              <Stack size={14} />
            </button>
          ) : null}
          <button type="button" className="ade-home-edit-btn" data-danger="true" title="Remove" aria-label={`Remove ${meta.title}`} onClick={() => remove(item.id)}>
            <X size={13} weight="bold" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

type ResizeDrag = { id: string; startX: number; startY: number; startW: number; startH: number; w: number; h: number };

export function HomeWidgetGrid({
  single,
  style,
  renderWidget,
}: {
  /** The page's card-look overrides (opacity and blur tokens), scoped to the widgets. */
  style?: React.CSSProperties;
  /** Only the Projects widget (the hosted client with no machines yet). */
  single: boolean;
  renderWidget: (ctx: WidgetRenderContext) => ReactNode;
}) {
  const layout = useHomeLayoutStore((s) => s.layout);
  const editing = useHomeLayoutStore((s) => s.editing);
  const setEditing = useHomeLayoutStore((s) => s.setEditing);
  const moveCell = useHomeLayoutStore((s) => s.moveCell);
  const nudgeCell = useHomeLayoutStore((s) => s.nudgeCell);
  const resizeTo = useHomeLayoutStore((s) => s.resizeTo);
  const setMetrics = useHomeGridMetrics((s) => s.set);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const [resizeDrag, setResizeDrag] = useState<ResizeDrag | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element) return undefined;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBox((current) => (current && Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1 ? current : { width: rect.width, height: rect.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const metrics = useMemo(() => (box ? gridMetrics(box.width, box.height) : null), [box]);
  useEffect(() => {
    if (metrics) setMetrics(metrics);
  }, [metrics, setMetrics]);

  const allCells = useMemo(() => layoutCells(layout.items), [layout.items]);
  const cells = single ? allCells.filter((cell) => cell.host.type === "projects").slice(0, 1) : allCells;

  // A resize in progress packs with the dragged span so neighbours reflow live.
  const packedCells = useMemo((): HomeLayoutCell[] => {
    if (!resizeDrag) return cells;
    return cells.map((cell) => (cell.host.id === resizeDrag.id ? { ...cell, host: { ...cell.host, w: resizeDrag.w, h: resizeDrag.h } } : cell));
  }, [cells, resizeDrag]);
  const packed: PackResult | null = useMemo(
    () => (metrics && !single ? packLayout(packedCells, metrics, widgetLimits) : null),
    [metrics, packedCells, single],
  );
  const resizeBlocked = Boolean(resizeDrag && packed?.hidden.some((cell) => cell.host.id === resizeDrag.id));

  const endDrag = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
  }, []);

  const startResize = (event: React.PointerEvent, cell: HomeLayoutCell, span: { w: number; h: number }) => {
    if (!metrics) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setResizeDrag({ id: cell.host.id, startX: event.clientX, startY: event.clientY, startW: span.w, startH: span.h, w: span.w, h: span.h });
  };
  const moveResize = (event: React.PointerEvent) => {
    if (!resizeDrag || !metrics || !packed) return;
    const colW = (metrics.width - (metrics.columns - 1) * GRID_GAP) / metrics.columns;
    const rowH = (metrics.height - (packed.rows - 1) * GRID_GAP) / packed.rows;
    const host = cells.find((cell) => cell.host.id === resizeDrag.id)?.host;
    if (!host) return;
    const next = clampSpan(
      host.type,
      resizeDrag.startW + (event.clientX - resizeDrag.startX) / (colW + GRID_GAP),
      resizeDrag.startH + (event.clientY - resizeDrag.startY) / (rowH + GRID_GAP),
      metrics,
      widgetLimits,
    );
    if (next.w !== resizeDrag.w || next.h !== resizeDrag.h) setResizeDrag({ ...resizeDrag, ...next });
  };
  const endResize = () => {
    if (!resizeDrag) return;
    if (!resizeBlocked && (resizeDrag.w !== resizeDrag.startW || resizeDrag.h !== resizeDrag.startH)) {
      resizeTo(resizeDrag.id, resizeDrag.w, resizeDrag.h);
    }
    setResizeDrag(null);
  };

  const columns = metrics?.columns ?? 3;
  const rows = packed?.rows ?? 2;
  const gridTemplateColumns = columns === 3
    ? "minmax(0, 1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)"
    : `repeat(${columns}, minmax(0, 1fr))`;
  const placements = packed?.placed ?? [];
  const hidden = packed?.hidden ?? [];

  return (
    <div ref={hostRef} className="ade-home-grid-host">
      <div
        className="ade-home-grid"
        data-single={single ? "true" : undefined}
        data-editing={editing ? "true" : undefined}
        data-dragging={dragId ? "true" : undefined}
        data-resizing={resizeDrag ? "true" : undefined}
        style={single ? style : {
          ...style,
          width: metrics ? `${metrics.width}px` : undefined,
          gridTemplateColumns,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          visibility: metrics ? undefined : "hidden",
        }}
      >
        {(single ? cells.map((cell) => ({ cell, x: 0, y: 0, ...itemSpan(cell.host) })) : placements).map(({ cell, x, y, w, h }, index) => {
          const { host, stacked } = cell;
          const marker = dropTarget?.id === host.id && dragId !== host.id ? dropTarget.side : undefined;
          const resizing = resizeDrag?.id === host.id;
          return (
            <div
              key={host.id}
              className="ade-home-cell"
              data-size={sizeClass(w, h)}
              data-drop={marker}
              data-dragged={dragId === host.id || undefined}
              data-resizing={resizing || undefined}
              data-blocked={resizing && resizeBlocked ? "true" : undefined}
              style={single ? undefined : { gridColumn: `${x + 1} / span ${w}`, gridRow: `${y + 1} / span ${h}` }}
              draggable={editing && !resizeDrag}
              onDragStart={(event) => {
                if (!editing || resizeDrag) return;
                event.dataTransfer.setData(WIDGET_DRAG_TYPE, host.id);
                event.dataTransfer.effectAllowed = "move";
                setDragId(host.id);
              }}
              onDragOver={(event) => {
                if (!dragId || !event.dataTransfer.types.includes(WIDGET_DRAG_TYPE)) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const side = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                if (dropTarget?.id !== host.id || dropTarget.side !== side) setDropTarget({ id: host.id, side });
              }}
              onDragEnter={(event) => {
                if (dragId) event.stopPropagation();
              }}
              onDragLeave={(event) => {
                if (dragId) event.stopPropagation();
              }}
              onDrop={(event) => {
                if (!dragId) return;
                event.preventDefault();
                event.stopPropagation();
                if (dropTarget && dropTarget.id !== dragId) moveCell(dragId, dropTarget.id, dropTarget.side);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              <WidgetFrame
                item={host}
                stacked={false}
                editing={editing}
                canStack={index > 0}
                renderWidget={renderWidget}
                span={{ w, h }}
                dragHandleProps={{
                  onKeyDown: (event) => {
                    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                      event.preventDefault();
                      nudgeCell(host.id, -1);
                    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                      event.preventDefault();
                      nudgeCell(host.id, 1);
                    }
                  },
                }}
              />
              {stacked.map((item) => (
                <WidgetFrame key={item.id} item={item} stacked editing={editing} canStack={false} renderWidget={renderWidget} />
              ))}
              {editing && !single ? (
                <>
                  {resizing ? <div className="ade-home-resize-badge kit-num">{resizeBlocked ? "No room" : `${w} × ${h}`}</div> : null}
                  <div
                    className="ade-home-resize-handle"
                    role="slider"
                    tabIndex={-1}
                    aria-label={`Resize ${HOME_WIDGET_CATALOG[host.type].title}`}
                    aria-valuetext={`${w} by ${h} cells`}
                    title="Drag to resize"
                    onPointerDown={(event) => startResize(event, cell, { w, h })}
                    onPointerMove={moveResize}
                    onPointerUp={endResize}
                    onPointerCancel={() => setResizeDrag(null)}
                  />
                </>
              ) : null}
            </div>
          );
        })}
        {editing && cells.length === 0 ? (
          <div className="ade-home-grid-empty">Your home page is empty. Add a widget to start.</div>
        ) : null}
      </div>
      {hidden.length > 0 ? (
        <button
          type="button"
          className="ade-home-hidden-note"
          title={hidden.map((cell) => HOME_WIDGET_CATALOG[cell.host.type].title).join(", ")}
          onClick={() => setEditing(true)}
        >
          <EyeSlash size={12} aria-hidden />
          <span>
            {hidden.length} hidden — {editing ? hidden.map((cell) => HOME_WIDGET_CATALOG[cell.host.type].title).join(", ") : "enlarge the window or edit"}
          </span>
        </button>
      ) : null}
    </div>
  );
}
