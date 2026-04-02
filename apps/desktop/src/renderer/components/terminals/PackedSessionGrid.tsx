import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useDockLayout } from "../ui/DockLayoutState";
import { cn } from "../ui/cn";
import {
  GRID_GAP_PX,
  GRID_MAX_ROW_SPAN,
  GRID_COLUMN_SUBDIVISIONS,
  clampPackedGridSpan,
  computeDefaultRowSpan,
  computeMinimumColSpan,
  computeGridColumnCount,
  computeMinimumRowSpan,
  computePackedGridRowHeight,
  computePackedSpanPixels,
  packGridItems,
  readPackedGridSpan,
  reconcilePackedGridLayout,
  type PackedGridPlacement,
  type PackedGridSpan,
} from "./packedSessionGridMath";

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type PackedSessionGridTile = {
  id: string;
  minWidth: number;
  minHeight: number;
  selected?: boolean;
  onSelect?: () => void;
  header: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

type ResizeState = {
  tileId: string;
  direction: ResizeDirection;
  startX: number;
  startY: number;
  startSpan: PackedGridSpan;
  currentSpan: PackedGridSpan;
  pointerId: number;
  pointerTarget: HTMLElement | null;
};

const RESIZE_HANDLES: Array<{ direction: ResizeDirection; style: CSSProperties }> = [
  { direction: "n", style: { top: -6, left: 4, right: 4, height: 16, cursor: "n-resize" } },
  { direction: "s", style: { bottom: -6, left: 4, right: 4, height: 16, cursor: "s-resize" } },
  { direction: "e", style: { right: -6, top: 4, bottom: 4, width: 16, cursor: "e-resize" } },
  { direction: "w", style: { left: -6, top: 4, bottom: 4, width: 16, cursor: "w-resize" } },
  { direction: "ne", style: { right: -8, top: -8, width: 20, height: 20, cursor: "ne-resize" } },
  { direction: "nw", style: { left: -8, top: -8, width: 20, height: 20, cursor: "nw-resize" } },
  { direction: "se", style: { right: -8, bottom: -8, width: 20, height: 20, cursor: "se-resize" } },
  { direction: "sw", style: { left: -8, bottom: -8, width: 20, height: 20, cursor: "sw-resize" } },
];

function hasHorizontalResize(direction: ResizeDirection): boolean {
  return direction.includes("e") || direction.includes("w");
}

function hasVerticalResize(direction: ResizeDirection): boolean {
  return direction.includes("n") || direction.includes("s");
}

export function PackedSessionGrid({
  layoutId,
  tiles,
  className,
}: {
  layoutId: string;
  tiles: PackedSessionGridTile[];
  className?: string;
}) {
  const { layout, loaded, saveLayout } = useDockLayout(layoutId, {});
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [resizingTileId, setResizingTileId] = useState<string | null>(null);
  const [draftSpansById, setDraftSpansById] = useState<Record<string, PackedGridSpan>>({});

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setViewportSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const minRowSpans = useMemo(() => {
    const next: Record<string, number> = {};
    for (const tile of tiles) {
      next[tile.id] = computeMinimumRowSpan(tile.minHeight);
    }
    return next;
  }, [tiles]);

  const defaultRowSpan = useMemo(
    () => computeDefaultRowSpan(Object.values(minRowSpans)),
    [minRowSpans],
  );

  const defaultSpansById = useMemo(() => {
    const next: Record<string, PackedGridSpan> = {};
    for (const tile of tiles) {
      next[tile.id] = {
        colSpan: GRID_COLUMN_SUBDIVISIONS,
        rowSpan: Math.max(minRowSpans[tile.id] ?? 1, defaultRowSpan),
      };
    }
    return next;
  }, [defaultRowSpan, minRowSpans, tiles]);

  useEffect(() => {
    if (!loaded) return;
    const nextLayout = reconcilePackedGridLayout({
      layout,
      tileIds: tiles.map((tile) => tile.id),
      defaultSpansById,
    });
    const sameKeys = Object.keys(nextLayout).length === Object.keys(layout).length
      && Object.entries(nextLayout).every(([key, value]) => layout[key] === value);
    if (!sameKeys) {
      saveLayout(nextLayout);
    }
  }, [defaultSpansById, layout, loaded, saveLayout, tiles]);

  const columnCount = useMemo(() => {
    const minTileWidth = tiles.reduce((largest, tile) => Math.max(largest, tile.minWidth), 0);
    return computeGridColumnCount({
      containerWidth: viewportSize.width,
      containerHeight: viewportSize.height,
      tileCount: tiles.length,
      minTileWidth,
      defaultRowSpan,
    });
  }, [defaultRowSpan, tiles, viewportSize.height, viewportSize.width]);

  const trackCount = useMemo(
    () => Math.max(GRID_COLUMN_SUBDIVISIONS, columnCount * GRID_COLUMN_SUBDIVISIONS),
    [columnCount],
  );

  const trackWidth = useMemo(() => {
    if (trackCount <= 0 || viewportSize.width <= 0) return 0;
    const availableWidth = viewportSize.width - GRID_GAP_PX * Math.max(0, trackCount - 1);
    return Math.max(0, availableWidth / trackCount);
  }, [trackCount, viewportSize.width]);

  const minColSpans = useMemo(() => {
    const next: Record<string, number> = {};
    for (const tile of tiles) {
      next[tile.id] = computeMinimumColSpan({
        minWidthPx: tile.minWidth,
        trackWidthPx: trackWidth,
      });
    }
    return next;
  }, [tiles, trackWidth]);

  const spansById = useMemo(() => {
    const next: Record<string, PackedGridSpan> = {};
    for (const tile of tiles) {
      next[tile.id] = clampPackedGridSpan({
        span: readPackedGridSpan(layout, tile.id, defaultSpansById[tile.id] ?? { colSpan: 1, rowSpan: 1 }),
        columnCount: trackCount,
        minColSpan: minColSpans[tile.id] ?? 1,
        minRowSpan: minRowSpans[tile.id] ?? 1,
        maxRowSpan: GRID_MAX_ROW_SPAN,
      });
    }
    return next;
  }, [defaultSpansById, layout, minColSpans, minRowSpans, tiles, trackCount]);

  const effectiveSpansById = useMemo(() => {
    if (!Object.keys(draftSpansById).length) return spansById;
    const next = { ...spansById };
    for (const [tileId, span] of Object.entries(draftSpansById)) {
      next[tileId] = span;
    }
    return next;
  }, [draftSpansById, spansById]);

  const packedItems = useMemo(() => {
    return tiles.map((tile) => ({
      id: tile.id,
      minRowSpan: minRowSpans[tile.id] ?? 1,
      span: effectiveSpansById[tile.id] ?? defaultSpansById[tile.id] ?? { colSpan: 1, rowSpan: 1 },
    }));
  }, [defaultSpansById, effectiveSpansById, minRowSpans, tiles]);

  const packed = useMemo(
    () => packGridItems(packedItems, trackCount),
    [packedItems, trackCount],
  );

  const rowHeight = useMemo(
    () =>
      computePackedGridRowHeight({
        containerHeight: viewportSize.height,
        totalRows: packed.totalRows,
      }),
    [packed.totalRows, viewportSize.height],
  );

  const placementById = useMemo(() => {
    const next = new Map<string, PackedGridPlacement>();
    for (const placement of packed.placements) {
      next.set(placement.id, placement);
    }
    return next;
  }, [packed.placements]);

  const contentHeight = useMemo(
    () => computePackedSpanPixels(packed.totalRows, rowHeight),
    [packed.totalRows, rowHeight],
  );

  const stopResize = useCallback((clearDraft = true) => {
    const state = resizeStateRef.current;
    if (state?.pointerTarget && state.pointerTarget.hasPointerCapture?.(state.pointerId)) {
      state.pointerTarget.releasePointerCapture(state.pointerId);
    }
    resizeStateRef.current = null;
    setResizingTileId(null);
    if (clearDraft) {
      setDraftSpansById({});
    }
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    return () => {
      stopResize();
    };
  }, [stopResize]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const state = resizeStateRef.current;
      if (!state || trackWidth <= 0 || rowHeight <= 0) return;
      const colUnit = trackWidth + GRID_GAP_PX;
      const rowUnit = rowHeight + GRID_GAP_PX;

      let nextColSpan = state.startSpan.colSpan;
      let nextRowSpan = state.startSpan.rowSpan;

      if (hasHorizontalResize(state.direction)) {
        const rawDelta = (event.clientX - state.startX) / colUnit;
        const normalizedDelta = state.direction.includes("w") ? -rawDelta : rawDelta;
        nextColSpan = state.startSpan.colSpan + Math.round(normalizedDelta);
      }

      if (hasVerticalResize(state.direction)) {
        const rawDelta = (event.clientY - state.startY) / rowUnit;
        const normalizedDelta = state.direction.includes("n") ? -rawDelta : rawDelta;
        nextRowSpan = state.startSpan.rowSpan + Math.round(normalizedDelta);
      }

      const clamped = clampPackedGridSpan({
        span: { colSpan: nextColSpan, rowSpan: nextRowSpan },
        columnCount: trackCount,
        minColSpan: minColSpans[state.tileId] ?? 1,
        minRowSpan: minRowSpans[state.tileId] ?? 1,
        maxRowSpan: GRID_MAX_ROW_SPAN,
      });
      if (
        clamped.colSpan === state.currentSpan.colSpan
        && clamped.rowSpan === state.currentSpan.rowSpan
      ) {
        return;
      }

      resizeStateRef.current = {
        ...state,
        currentSpan: clamped,
      };
      setDraftSpansById((prev) => {
        const current = prev[state.tileId];
        if (current?.colSpan === clamped.colSpan && current?.rowSpan === clamped.rowSpan) {
          return prev;
        }
        return {
          ...prev,
          [state.tileId]: clamped,
        };
      });
    };

    const handlePointerUp = () => {
      const state = resizeStateRef.current;
      if (state && (
        state.currentSpan.colSpan !== state.startSpan.colSpan
        || state.currentSpan.rowSpan !== state.startSpan.rowSpan
      )) {
        saveLayout((prev) => ({
          ...prev,
          [`${state.tileId}:col`]: state.currentSpan.colSpan,
          [`${state.tileId}:row`]: state.currentSpan.rowSpan,
        }));
      }
      stopResize();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [minColSpans, minRowSpans, rowHeight, saveLayout, stopResize, trackCount, trackWidth]);

  const beginResize = useCallback((tileId: string, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.style.cursor = `${direction}-resize`;
    resizeStateRef.current = {
      tileId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startSpan: spansById[tileId] ?? { colSpan: 1, rowSpan: 1 },
      currentSpan: spansById[tileId] ?? { colSpan: 1, rowSpan: 1 },
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
    };
    setResizingTileId(tileId);
    document.body.style.userSelect = "none";
  }, [spansById]);

  return (
    <div ref={viewportRef} className={cn("min-h-0 flex-1 overflow-auto p-2", className)}>
      <div
        className="relative min-h-full"
        style={{ height: `${Math.max(contentHeight, viewportSize.height)}px` }}
      >
        {tiles.map((tile) => {
          const placement = placementById.get(tile.id);
          if (!placement) return null;

          const left = (placement.column - 1) * (trackWidth + GRID_GAP_PX);
          const top = (placement.row - 1) * (rowHeight + GRID_GAP_PX);
          const width = computePackedSpanPixels(placement.colSpan, trackWidth);
          const height = computePackedSpanPixels(placement.rowSpan, rowHeight);
          const slotStart = Math.ceil(placement.column / GRID_COLUMN_SUBDIVISIONS);

          return (
            <section
              key={tile.id}
              data-grid-tile-id={tile.id}
              data-grid-slot-start={slotStart}
              data-grid-col-start={placement.column}
              data-grid-col-span={placement.colSpan}
              data-grid-row-start={placement.row}
              data-grid-row-span={placement.rowSpan}
              className={cn(
                "group absolute min-h-0 min-w-0",
              )}
              style={{
                left,
                top,
                width,
                height,
              }}
              onMouseDown={() => tile.onSelect?.()}
            >
              <div className={cn(
                "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md",
                tile.className,
              )}>
                {tile.header}
                <div className="min-h-0 flex-1 overflow-hidden">{tile.children}</div>
              </div>
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 rounded-md border border-white/[0.04] transition-opacity",
                  tile.selected || resizingTileId === tile.id ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              />
              {RESIZE_HANDLES.map((handle) => (
                <div
                  key={handle.direction}
                  data-grid-resize-handle={handle.direction}
                  className="absolute z-20 rounded-md"
                  style={{ ...handle.style, touchAction: "none" }}
                  onPointerDown={(event) => beginResize(tile.id, handle.direction, event)}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
