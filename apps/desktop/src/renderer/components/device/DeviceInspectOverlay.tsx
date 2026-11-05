import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { ChatText, Copy } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { DeviceToolId } from "./deviceTool";

/*
 * The Inspect overlay both device panes share: a box per element over the
 * live picture, a chip for the hovered one, and a card for the picked one.
 * Each tool brings an adapter for its own element shape (Apple's snapshot
 * elements, Android's UI tree), so the boxes, hit test, keys and card are one
 * piece of code.
 */

export type InspectFrame = { x: number; y: number; width: number; height: number };

export type DeviceInspectAdapter<E> = {
  /** Unique within one snapshot; the hovered and selected refs are these. */
  id: (element: E) => string;
  /** In the device points `deviceToView` takes. */
  frame: (element: E) => InspectFrame;
  /** The chip's two parts and the card's rows. */
  describe: (element: E) => { title: string; subtitle: string; rows: [string, string][] };
  /** Nearest first, for Alt/Option cycling. */
  ancestors: (elements: readonly E[], element: E) => E[];
};

/** The anchored card's own size, so it can be flipped and clamped before it is drawn. */
const CARD_WIDTH = 236;
const CARD_MARGIN = 8;

export type DeviceInspectOverlayProps<E> = {
  tool: DeviceToolId;
  adapter: DeviceInspectAdapter<E>;
  elements: E[];
  /** Maps a device point to overlay-local CSS pixels; supplied by the presenter (flat or 3D). Null while the presenter cannot map (no body yet in 3D). */
  deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null;
  hoveredRef: string | null;
  selectedRef: string | null;
  onHover: (ref: string | null) => void;
  onSelect: (ref: string | null) => void;
  /**
   * The card's two verbs. Both are optional: a host with no composer still gets the
   * card and its details, with the button it cannot honour disabled rather
   * than a click that quietly does nothing.
   */
  onInsertIntoChat?: ((element: E) => void) | undefined;
  onCopy?: ((element: E) => void) | undefined;
  /** Alt/Option cycles to the ancestor of the hovered element; the overlay owns the key handling while focused. */
  className?: string;
};

type ViewRect = {
  id: string;
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  area: number;
};

function overlayPoint(event: PointerEvent<HTMLDivElement>): { x: number; y: number } {
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function hitViewRect(rects: readonly ViewRect[], point: { x: number; y: number }): ViewRect | null {
  let best: ViewRect | null = null;
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      point.x < rect.left
      || point.x > rect.left + rect.width
      || point.y < rect.top
      || point.y > rect.top + rect.height
    ) {
      continue;
    }
    if (
      !best
      || rect.area < best.area
      || (rect.area === best.area && rect.index > best.index)
    ) {
      best = rect;
    }
  }
  return best;
}

/** The picked element's details, anchored under its frame (flipped above it near the bottom). */
function InspectCard<E>({
  tool,
  adapter,
  element,
  rect,
  bounds,
  onInsertIntoChat,
  onCopy,
  onClose,
}: {
  tool: DeviceToolId;
  adapter: DeviceInspectAdapter<E>;
  element: E;
  rect: ViewRect;
  bounds: { width: number; height: number };
  onInsertIntoChat?: ((element: E) => void) | undefined;
  onCopy?: ((element: E) => void) | undefined;
  onClose: () => void;
}) {
  const described = adapter.describe(element);
  const below = rect.top + rect.height + CARD_MARGIN;
  const flip = bounds.height > 0 && below + 150 > bounds.height;
  const top = flip ? Math.max(CARD_MARGIN, rect.top - 150 - CARD_MARGIN) : below;
  const maxLeft = bounds.width > 0 ? bounds.width - CARD_WIDTH - CARD_MARGIN : rect.left;
  const left = Math.max(CARD_MARGIN, Math.min(rect.left, Math.max(CARD_MARGIN, maxLeft)));
  const rows = described.rows;
  return (
    <div
      data-testid={`${tool}-inspect-card`}
      role="dialog"
      aria-label={`Inspect ${described.title}`}
      className={cn(
        "pointer-events-auto absolute z-[2] flex flex-col gap-1 rounded-lg border border-border",
        "bg-surface p-2 font-sans text-[11px] text-fg shadow-lg",
      )}
      style={{ left, top, width: CARD_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="min-w-0 truncate text-[11px] font-medium text-fg">{described.title}</div>
      <div className="flex flex-col">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-start gap-1.5 py-[1px]">
            <span className="w-[4.5rem] shrink-0 text-muted-fg/70">{label}</span>
            <span className="min-w-0 flex-1 break-words text-fg/85">{value}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-nowrap items-center gap-1 pt-0.5">
        <button
          type="button"
          data-testid={`${tool}-inspect-card-insert`}
          className={CARD_BUTTON}
          disabled={!onInsertIntoChat}
          onClick={() => onInsertIntoChat?.(element)}
        >
          <ChatText size={12} aria-hidden="true" />
          Insert into chat
        </button>
        <button
          type="button"
          data-testid={`${tool}-inspect-card-copy`}
          className={CARD_BUTTON}
          disabled={!onCopy}
          onClick={() => onCopy?.(element)}
        >
          <Copy size={12} aria-hidden="true" />
          Copy
        </button>
        <button
          type="button"
          aria-label="Close inspect details"
          className={cn(CARD_BUTTON, "ml-auto px-1.5")}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

const CARD_BUTTON = cn(
  "inline-flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-md border border-border bg-bg px-1.5",
  "font-sans text-[11px] text-fg/85 hover:bg-fg/[0.07] disabled:cursor-not-allowed disabled:opacity-40",
);

function DeviceInspectOverlayInner<E>({
  tool,
  adapter,
  elements,
  deviceToView,
  hoveredRef,
  selectedRef,
  onHover,
  onSelect,
  onInsertIntoChat,
  onCopy,
  className,
}: DeviceInspectOverlayProps<E>) {
  const leafRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });

  const viewRects = useMemo<ViewRect[]>(() => {
    if (!deviceToView) return [];
    return elements.map((element, index) => {
      const frame = adapter.frame(element);
      const topLeft = deviceToView({ x: frame.x, y: frame.y });
      const bottomRight = deviceToView({
        x: frame.x + frame.width,
        y: frame.y + frame.height,
      });
      const left = Math.min(topLeft.x, bottomRight.x);
      const top = Math.min(topLeft.y, bottomRight.y);
      const width = Math.abs(bottomRight.x - topLeft.x);
      const height = Math.abs(bottomRight.y - topLeft.y);
      return {
        id: adapter.id(element),
        index,
        left,
        top,
        width,
        height,
        area: width * height,
      };
    });
  }, [adapter, deviceToView, elements]);

  const rectById = useMemo(() => {
    const map = new Map<string, ViewRect>();
    for (const rect of viewRects) map.set(rect.id, rect);
    return map;
  }, [viewRects]);

  // Measured rather than observed: the card is the only thing that needs the
  // box, and it is only ever drawn right after a click.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setBounds((current) => (
      current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height }
    ));
  }, [selectedRef, viewRects]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const hit = hitViewRect(viewRects, overlayPoint(event));
    const hitId = hit?.id ?? null;
    if (leafRef.current === hitId) return;
    leafRef.current = hitId;
    onHover(hitId);
  }, [onHover, viewRects]);

  const handlePointerLeave = useCallback(() => {
    leafRef.current = null;
    onHover(null);
  }, [onHover]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.focus();
  }, []);

  const find = useCallback(
    (ref: string | null | undefined): E | null => (ref ? elements.find((element) => adapter.id(element) === ref) ?? null : null),
    [adapter, elements],
  );

  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const hit = hitViewRect(viewRects, {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    const ref = hoveredRef && find(hoveredRef)
      ? hoveredRef
      : hit?.id ?? null;
    onSelect(ref);
  }, [find, hoveredRef, onSelect, viewRects]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onSelect(null);
      return;
    }
    if (event.key !== "Alt") return;
    event.preventDefault();
    const leafId = leafRef.current ?? hoveredRef;
    if (!leafId) return;
    const leaf = find(leafId);
    if (!leaf) return;
    const chain = [leaf, ...adapter.ancestors(elements, leaf)];
    if (chain.length < 2) return;
    const currentId = hoveredRef ?? adapter.id(leaf);
    const currentIndex = chain.findIndex((element) => adapter.id(element) === currentId);
    const next = chain[(currentIndex + 1) % chain.length];
    if (!next) return;
    onHover(adapter.id(next));
  }, [adapter, elements, find, hoveredRef, onHover, onSelect]);

  if (!deviceToView) return null;

  const hovered = find(hoveredRef);
  const selected = find(selectedRef);
  const selectedRect = selected ? rectById.get(adapter.id(selected)) ?? null : null;
  const chipElement = hovered ?? selected;
  const chipRect = chipElement ? rectById.get(adapter.id(chipElement)) : null;
  const chip = chipElement ? adapter.describe(chipElement) : null;

  return (
    <div
      ref={rootRef}
      className={cn("absolute inset-0 cursor-crosshair outline-none", className)}
      data-testid={`${tool}-inspect-overlay`}
      tabIndex={0}
      role="presentation"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {viewRects.map((rect) => {
        const isSelected = rect.id === selectedRef;
        const isHovered = rect.id === hoveredRef;
        return (
          <div
            key={rect.id}
            className={cn(
              "pointer-events-none absolute box-border",
              isSelected
                ? "border-2 border-cyan-300/95 bg-cyan-500/22"
                : isHovered
                  ? "border border-cyan-300/90 bg-transparent"
                  : "border border-cyan-400/20 bg-transparent",
            )}
            style={{
              left: rect.left,
              top: rect.top,
              width: Math.max(1, rect.width),
              height: Math.max(1, rect.height),
            }}
          />
        );
      })}
      {selected && selectedRect ? (
        <InspectCard
          tool={tool}
          adapter={adapter}
          element={selected}
          rect={selectedRect}
          bounds={bounds}
          onInsertIntoChat={onInsertIntoChat}
          onCopy={onCopy}
          onClose={() => onSelect(null)}
        />
      ) : null}
      {chip && chipRect ? (
        <div
          className="pointer-events-none absolute z-[1] max-w-[220px] truncate rounded-md border border-cyan-300/30 bg-black/72 px-1.5 py-0.5 font-sans text-[10px] text-[#cffafe]/95 shadow-lg backdrop-blur"
          style={{
            left: chipRect.left,
            top: Math.max(0, chipRect.top - 22),
          }}
        >
          <span className="font-medium">{chip.title}</span>
          <span className="ml-1 opacity-65">{chip.subtitle}</span>
        </div>
      ) : null}
    </div>
  );
}

export const DeviceInspectOverlay = memo(DeviceInspectOverlayInner) as typeof DeviceInspectOverlayInner;
