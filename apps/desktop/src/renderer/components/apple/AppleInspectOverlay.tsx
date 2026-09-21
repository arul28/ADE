import { memo, useCallback, useMemo, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cn } from "../ui/cn";
import {
  ancestorsOf,
  describeElement,
  findElement,
  type IosSimulatorSnapshotElement,
} from "./appleInspectGeometry";

export type AppleInspectOverlayProps = {
  elements: IosSimulatorSnapshotElement[];
  /** Maps a device point to overlay-local CSS pixels; supplied by the presenter (flat or 3D). Null while the presenter cannot map (3D mid-orbit). */
  deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null;
  hoveredRef: string | null;
  selectedRef: string | null;
  onHover: (ref: string | null) => void;
  onSelect: (ref: string | null) => void;
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

function AppleInspectOverlayInner({
  elements,
  deviceToView,
  hoveredRef,
  selectedRef,
  onHover,
  onSelect,
  className,
}: AppleInspectOverlayProps) {
  const leafRef = useRef<string | null>(null);

  const viewRects = useMemo<ViewRect[]>(() => {
    if (!deviceToView) return [];
    return elements.map((element, index) => {
      const frame = element.frame;
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
        id: element.id,
        index,
        left,
        top,
        width,
        height,
        area: width * height,
      };
    });
  }, [deviceToView, elements]);

  const rectById = useMemo(() => {
    const map = new Map<string, ViewRect>();
    for (const rect of viewRects) map.set(rect.id, rect);
    return map;
  }, [viewRects]);

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

  const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const hit = hitViewRect(viewRects, {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
    const ref = hoveredRef && findElement(elements, hoveredRef)
      ? hoveredRef
      : hit?.id ?? null;
    onSelect(ref);
  }, [elements, hoveredRef, onSelect, viewRects]);

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
    const leaf = findElement(elements, leafId);
    if (!leaf) return;
    const chain = [leaf, ...ancestorsOf(elements, leaf.id)];
    if (chain.length < 2) return;
    const currentId = hoveredRef ?? leaf.id;
    const currentIndex = chain.findIndex((element) => element.id === currentId);
    const next = chain[(currentIndex + 1) % chain.length];
    if (!next) return;
    onHover(next.id);
  }, [elements, hoveredRef, onHover, onSelect]);

  if (!deviceToView) return null;

  const hovered = findElement(elements, hoveredRef);
  const selected = findElement(elements, selectedRef);
  const chipElement = hovered ?? selected;
  const chipRect = chipElement ? rectById.get(chipElement.id) : null;
  const chip = chipElement ? describeElement(chipElement) : null;

  return (
    <div
      className={cn("absolute inset-0 cursor-crosshair outline-none", className)}
      data-testid="apple-inspect-overlay"
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
      {chip && chipRect ? (
        <div
          className="pointer-events-none absolute z-[1] max-w-[220px] truncate rounded-md border border-cyan-300/30 bg-black/72 px-1.5 py-0.5 font-sans text-[10px] text-cyan-100/95 shadow-lg backdrop-blur"
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

export const AppleInspectOverlay = memo(AppleInspectOverlayInner);
AppleInspectOverlay.displayName = "AppleInspectOverlay";
