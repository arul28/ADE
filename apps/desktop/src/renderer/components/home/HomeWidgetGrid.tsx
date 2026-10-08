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
import { MotionConfig, motion } from "motion/react";
import { ArrowsInLineVertical, DotsSixVertical, EyeSlash, Stack, X } from "@phosphor-icons/react";
import {
  layoutCells,
  useHomeLayoutStore,
  type HomeLayoutCell,
  type HomeLayoutItem,
} from "./homeLayout";
import { HOME_CLASS_LABEL, HOME_WIDGET_CATALOG, widgetShape } from "./homeWidgetCatalog";
import {
  classSpan,
  gridMetrics,
  itemSizeClass,
  packLayout,
  shapeClasses,
  storedSizeFor,
  type GridMetrics,
  type HomeSizeClass,
  type PackResult,
} from "./homeGridPack";
import { WelcomeCardHead } from "../projects/ProjectWelcomeSidePanels";

/**
 * The home page's grid. It never scrolls and never leaves a gap: its size
 * comes from the window (more columns on a wider window, as many rows as
 * fit), the layout engine (`homeGridPack.ts`) packs the widgets in order at
 * their size class and hands leftover cells to the widgets that use room
 * well, and what has no room is hidden behind a quiet "N hidden" note.
 * Cells glide to their new places when the layout reflows.
 *
 * Edit mode turns every cell into a tile with its own controls: a handle
 * (drag, or arrow keys) to reorder, the size classes the widget offers,
 * stack or unstack, and remove. Widget content goes inert while editing so a
 * drag never opens a project by accident.
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
  const placed = useContext(WidgetSpanContext);
  if (placed) return placed;
  const shape = widgetShape(item.type);
  return classSpan(shape, itemSizeClass(item, shape));
}

/** The live grid's size, for the gallery's "is there room?" check. */
export const useHomeGridMetrics = create<{
  metrics: GridMetrics | null;
  set: (metrics: GridMetrics) => void;
  /** Bumped when an empty cell asks for the gallery; edit mode's toolbar opens it (also on mount). */
  pickerRequest: number;
  requestPicker: () => void;
}>((set) => ({
  metrics: null,
  set: (metrics) => set({ metrics }),
  pickerRequest: 0,
  requestPicker: () => set((state) => ({ pickerRequest: state.pickerRequest + 1 })),
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
  shownClass,
}: {
  item: HomeLayoutItem;
  stacked: boolean;
  editing: boolean;
  canStack: boolean;
  renderWidget: (ctx: WidgetRenderContext) => ReactNode;
  dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  /** The span the grid placed this widget at (a host only). */
  span?: { w: number; h: number };
  /** The class it is shown at, when the layout had to show a smaller one. */
  shownClass?: HomeSizeClass;
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
  const shape = widgetShape(item.type);
  const classes = shapeClasses(shape);
  const asked = itemSizeClass(item, shape);
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
          {!stacked && classes.length > 1 ? (
            <div className="ade-home-edit-sizes" role="radiogroup" aria-label={`${meta.title} size`}>
              {classes.map((cls) => {
                const preset = shape.classes[cls]!;
                const squeezed = shownClass != null && shownClass !== asked && cls === asked;
                return (
                  <button
                    key={cls}
                    type="button"
                    role="radio"
                    aria-checked={asked === cls}
                    aria-label={HOME_CLASS_LABEL[cls].long}
                    data-squeezed={squeezed || undefined}
                    title={squeezed
                      ? `${HOME_CLASS_LABEL[cls].long} · no room for it now, shown ${HOME_CLASS_LABEL[shownClass].long.toLowerCase()}`
                      : `${HOME_CLASS_LABEL[cls].long} · ${preset.w} × ${preset.h}`}
                    onClick={() => resize(item.id, storedSizeFor(cls, shape))}
                  >
                    <span className="ade-home-edit-size-long">{HOME_CLASS_LABEL[cls].long}</span>
                    <span className="ade-home-edit-size-short" aria-hidden>{HOME_CLASS_LABEL[cls].short}</span>
                  </button>
                );
              })}
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

/** Cells glide to their new places on a reflow; sizes snap (scaling text mid-flight reads badly). */
const REFLOW = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as const;

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
  const setMetrics = useHomeGridMetrics((s) => s.set);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);
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

  // A box with no size has not been laid out (a hidden pane, or no layout
  // engine at all): pack for the shipped page's size until it has one.
  const metrics = useMemo(() => {
    if (!box) return null;
    return box.width < 1 || box.height < 1 ? gridMetrics(1120, 640) : gridMetrics(box.width, box.height);
  }, [box]);
  useEffect(() => {
    if (metrics) setMetrics(metrics);
  }, [metrics, setMetrics]);

  const allCells = useMemo(() => layoutCells(layout.items), [layout.items]);
  const cells = useMemo(
    () => (single ? allCells.filter((cell) => cell.host.type === "projects").slice(0, 1) : allCells),
    [allCells, single],
  );
  const packed: PackResult | null = useMemo(
    () => (metrics && !single ? packLayout(cells, metrics, widgetShape) : null),
    [cells, metrics, single],
  );

  const endDrag = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
  }, []);

  const columns = metrics?.columns ?? 3;
  const rows = packed?.rows ?? 2;
  const gridTemplateColumns = columns === 3
    ? "minmax(0, 1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)"
    : `repeat(${columns}, minmax(0, 1fr))`;
  const hidden = packed?.hidden ?? [];
  const shown: Array<{ cell: HomeLayoutCell; x: number; y: number; w: number; h: number; cls?: HomeSizeClass }> = single
    ? cells.map((cell) => ({ cell, x: 0, y: 0, w: 1, h: 1 }))
    : packed?.placed ?? [];

  return (
    <MotionConfig reducedMotion="user">
      <div ref={hostRef} className="ade-home-grid-host">
        <div
          className="ade-home-grid"
          data-single={single ? "true" : undefined}
          data-editing={editing ? "true" : undefined}
          data-dragging={dragId ? "true" : undefined}
          style={single ? style : {
            ...style,
            width: metrics ? `${metrics.width}px` : undefined,
            gridTemplateColumns,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            visibility: metrics ? undefined : "hidden",
          }}
        >
          {shown.map(({ cell, x, y, w, h, cls }, index) => {
            const { host, stacked } = cell;
            const marker = dropTarget?.id === host.id && dragId !== host.id ? dropTarget.side : undefined;
            return (
              <motion.div
                key={host.id}
                layout={single ? false : "position"}
                transition={REFLOW}
                className="ade-home-cell"
                data-class={cls}
                data-drop={marker}
                data-dragged={dragId === host.id || undefined}
                style={single ? undefined : { gridColumn: `${x + 1} / span ${w}`, gridRow: `${y + 1} / span ${h}` }}
                draggable={editing}
                onDragStartCapture={(event: React.DragEvent<HTMLDivElement>) => {
                  if (!editing) return;
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
                onDragEndCapture={endDrag}
              >
                <WidgetFrame
                  item={host}
                  stacked={false}
                  editing={editing}
                  canStack={index > 0}
                  renderWidget={renderWidget}
                  span={single ? undefined : { w, h }}
                  shownClass={cls}
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
              </motion.div>
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
    </MotionConfig>
  );
}
