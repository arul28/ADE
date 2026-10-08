import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { ArrowsInLineVertical, DotsSixVertical, Stack, X } from "@phosphor-icons/react";
import {
  layoutCells,
  sizeSpan,
  useHomeLayoutStore,
  type HomeLayoutItem,
  type HomeWidgetSize,
} from "./homeLayout";
import { HOME_SIZE_LABEL, HOME_WIDGET_CATALOG } from "./homeWidgetCatalog";
import { WelcomeCardHead } from "../projects/ProjectWelcomeSidePanels";

/**
 * The home page's grid. Each cell holds one widget and anything stacked under
 * it. Rows split the page height (the page still never scrolls with the
 * default preset); a layout with more rows than fit gives every row a usable
 * minimum and scrolls inside the grid instead of stretching the page.
 *
 * Edit mode turns every cell into a draggable tile with its own controls:
 * a handle (drag, or arrow keys), the sizes the widget supports, stack or
 * unstack, and remove. Widget content goes inert while editing so a drag never
 * opens a project by accident.
 */

const WIDGET_DRAG_TYPE = "application/x-ade-home-widget";

export type WidgetRenderContext = { item: HomeLayoutItem; stacked: boolean; editing: boolean };

/** True while the widget is on screen and the window is visible; widgets that poll pause otherwise. */
const WidgetVisibleContext = createContext(true);
export function useWidgetVisible(): boolean {
  return useContext(WidgetVisibleContext);
}

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
  minHeight,
}: {
  /** A stack host keeps its declared minimum; the stacked card gets the rest. */
  minHeight?: number;
  item: HomeLayoutItem;
  stacked: boolean;
  editing: boolean;
  canStack: boolean;
  renderWidget: (ctx: WidgetRenderContext) => ReactNode;
  dragHandleProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
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
  return (
    <div ref={ref} className="ade-home-widget" data-stacked={stacked || undefined} data-type={item.type} style={minHeight ? { minHeight } : undefined}>
      <div ref={contentRef} className="ade-home-widget-content">
        <WidgetVisibleContext.Provider value={visible}>
          <WidgetBoundary title={meta.title}>
            {content ?? (
              <section className="kit-card ade-home-card" aria-label={meta.title}>
                <WelcomeCardHead icon={meta.icon} title={meta.title} />
                <div className="ade-home-empty"><span>Hidden while empty.</span></div>
              </section>
            )}
          </WidgetBoundary>
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
          {!stacked ? (
            <div className="ade-home-edit-sizes" role="radiogroup" aria-label={`${meta.title} size`}>
              {(["s", "m", "l", "w"] as HomeWidgetSize[]).filter((size) => meta.sizes.includes(size)).map((size) => (
                <button
                  key={size}
                  type="button"
                  role="radio"
                  aria-checked={item.size === size}
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

export function HomeWidgetGrid({
  narrow,
  single,
  style,
  renderWidget,
}: {
  narrow: boolean;
  /** The page's card-look overrides (opacity and blur tokens), scoped to the widgets. */
  style?: React.CSSProperties;
  /** Only the Projects widget (the hosted client with no machines yet). */
  single: boolean;
  renderWidget: (ctx: WidgetRenderContext) => ReactNode;
}) {
  const layout = useHomeLayoutStore((s) => s.layout);
  const editing = useHomeLayoutStore((s) => s.editing);
  const moveCell = useHomeLayoutStore((s) => s.moveCell);
  const nudgeCell = useHomeLayoutStore((s) => s.nudgeCell);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);

  const columns = narrow ? 2 : layout.columns;
  const allCells = layoutCells(layout.items);
  const cells = single ? allCells.filter((cell) => cell.host.type === "projects").slice(0, 1) : allCells;

  const endDrag = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
  }, []);

  // The row floor: the tallest per-row share any cell needs to show its
  // widgets (and anything stacked under them) without clipping. Rows share
  // the page while they fit at that floor; past it the grid scrolls.
  const gap = 12;
  const rowFloor = cells.reduce((floor, { host, stacked }) => {
    const span = sizeSpan(host.size, columns, narrow);
    const effective: HomeWidgetSize = narrow && host.size === "m" ? "w" : host.size;
    const need = HOME_WIDGET_CATALOG[host.type].minHeight[effective]
      + stacked.reduce((sum, item) => sum + gap + Math.round(HOME_WIDGET_CATALOG[item.type].minHeight.s * 0.75), 0);
    return Math.max(floor, Math.ceil((need - gap * (span.rows - 1)) / span.rows));
  }, 0);

  const gridTemplateColumns = columns === 3
    ? "minmax(0, 1fr) minmax(0, 0.9fr) minmax(0, 0.9fr)"
    : `repeat(${columns}, minmax(0, 1fr))`;

  return (
    <div
      className="ade-home-grid"
      data-single={single ? "true" : undefined}
      data-editing={editing ? "true" : undefined}
      data-dragging={dragId ? "true" : undefined}
      style={single ? style : { ...style, gridTemplateColumns, ["--home-row-min" as string]: `${rowFloor}px` }}
    >
      {cells.map(({ host, stacked }, index) => {
        const span = sizeSpan(host.size, columns, narrow);
        const marker = dropTarget?.id === host.id && dragId !== host.id ? dropTarget.side : undefined;
        return (
          <div
            key={host.id}
            className="ade-home-cell"
            data-size={host.size}
            data-drop={marker}
            data-dragged={dragId === host.id || undefined}
            style={single ? undefined : { gridColumn: `span ${span.cols}`, gridRow: `span ${span.rows}` }}
            draggable={editing}
            onDragStart={(event) => {
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
            onDragEnd={endDrag}
          >
            <WidgetFrame
              item={host}
              stacked={false}
              editing={editing}
              canStack={index > 0}
              renderWidget={renderWidget}
              minHeight={stacked.length > 0 ? HOME_WIDGET_CATALOG[host.type].minHeight[narrow && host.size === "m" ? "w" : host.size] : undefined}
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
          </div>
        );
      })}
      {editing && cells.length === 0 ? (
        <div className="ade-home-grid-empty">Your home page is empty. Add a widget to start.</div>
      ) : null}
    </div>
  );
}
